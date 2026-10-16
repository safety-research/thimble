"""The release test's contract checks against Claude Code (scripts/e2e/contract_print.py and contract_module.py), which
run only with THIMBLE_LIVE_CLAUDE=1: what they read from a run, checked here on records shaped as Claude Code 2.1.291
wrote them, so a check that reads the wrong field fails here rather than passing or failing for the wrong reason live."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from app import config

E2E = Path(__file__).resolve().parents[2] / "scripts" / "e2e"
LIMIT_TEXT = ("Concurrent subagent limit reached. You can run 1 subagents at once. Do not retry. If the user wants more "
              "concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.")


def _load(name: str):
    sys.path.insert(0, str(E2E))
    spec = importlib.util.spec_from_file_location(name, E2E / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cp = _load("contract_print")
FMT = cp.formats(config.REPO_ROOT)


def _ev(event: str, **fields) -> dict:
    base = {"session_id": "s", "transcript_path": "/t/s.jsonl", "prompt_id": "p", "permission_mode": "auto",
            "hook_event_name": event}
    return {**base, **fields}


def _events(child_shape=("stop", "handback", "stop*")) -> list[dict]:
    out = [_ev("PreToolUse", tool_name="Agent", tool_use_id="toolu_main", tool_input={"subagent_type": cp.PARENT}),
           _ev("SubagentStart", agent_id="P", agent_type=cp.PARENT),
           _ev("PreToolUse", agent_id="P", agent_type=cp.PARENT, tool_name="mcp__contract__probe", tool_use_id="toolu_mcp",
               tool_input={"text": "parent"}),
           _ev("SubagentStart", agent_id="C", agent_type=cp.CHILD)]
    for step in child_shape:
        if step == "handback":
            out.append(_ev("PreToolUse", agent_id="C", agent_type=cp.CHILD, tool_name=cp.HANDBACK, tool_use_id="toolu_hb",
                           tool_input={"message": cp.CHILD_DONE}))
        else:
            stop = _ev("SubagentStop", agent_id="C", agent_type=cp.CHILD, stop_hook_active=step == "stop*",
                       agent_transcript_path="/t/s/subagents/agent-C.jsonl")
            if step == "stop":
                stop["last_assistant_message"] = cp.CHILD_DONE
            out.append(stop)
    return out


def test_the_matchers_come_from_thimble_s_own_code():
    assert FMT["meta_key"] == "claudecode/toolUseId"
    assert FMT["module_limit"].search(LIMIT_TEXT) and all(w in LIMIT_TEXT.lower() for w in FMT["limit_words"])
    assert FMT["plugin_call"] == "toolu_plugin_" and FMT["handback_lead"] == "[Subagent hand-back]"
    ok, detail = cp.check_limit_text([LIMIT_TEXT], FMT)
    assert ok, detail
    assert not cp.check_limit_text(["Agent type 'x' not found"], FMT)[0]
    assert not cp.check_limit_text([], FMT)[0]


def test_hook_fields_pass_on_claude_code_s_shapes_and_name_a_missing_one():
    ok, detail = cp.check_hook_fields(_events())
    assert ok, detail
    events = _events()
    del events[1]["agent_type"]
    ok, detail = cp.check_hook_fields(events)
    assert not ok and "SubagentStart.agent_type" in detail
    events = _events()
    events[0]["agent_id"] = "P"  # main's own call carrying an agent id
    assert "main's PreToolUse" in cp.check_hook_fields(events)[1]
