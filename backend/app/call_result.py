"""What a structured model call takes and gives back: the output schema (ToolSpec) and the result (CallResult).
agent_call.py makes every call as a subagent of the analyst's Claude Code session and answers with these
(NOCLAUDE.md)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# `no_session`: no Claude Code session runs thimble in the workspace's folder, so no agent could start (agent_call.py);
# `stopped`: the caller stopped the call
Status = Literal["ok", "refused", "rate_limited", "truncated", "no_tool_call", "timeout", "error", "no_session",
                 "stopped"]


@dataclass(frozen=True)
class ToolSpec:
    """The output schema of a call: its name, what it holds (`description`) and its JSON schema (`input_schema`)."""

    name: str
    description: str
    input_schema: dict


@dataclass
class CallResult:
    """What one structured call returned and what actually happened. A call NEVER raises; read `status`."""

    status: Status
    output: dict | None = None  # the jsonschema-validated answer; None unless status == "ok"
    model_requested: str = ""  # the model the call was asked to run on
    model_used: str | None = None  # the model that answered, when known
    fallback_note: str = ""  # "" when the requested model really ran
    duration_s: float = 0.0  # wall, retries included
    cost_usd: float | None = None  # what the call cost, when known (a subagent's cost is main's, so none)
    session_id: str | None = None  # the subagent's agent id
    attempts: int = 0  # turns sent, or agents started
    detail: str = ""  # one plain sentence for run.json, logs and notices; "" when ok
    text: str = ""  # the model's prose from the final attempt, for no_tool_call/refused diagnostics
    # status == "truncated" only: the output tool's last call as far as it got before the cut (a cut-off tool_use is
    # parsed leniently); None when no tool call had started
    partial: dict | None = None
    # {input_tokens, output_tokens, …} as the CLI reported them; None when it did not say
    usage: dict | None = None
    # the model that refused the call when this result is its rerun on the refusal row's model; "" otherwise
    refused_by: str = ""
