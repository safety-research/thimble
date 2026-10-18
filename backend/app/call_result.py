"""What a structured model call takes and gives back: the output schema (ToolSpec), the result (CallResult), and how an
answer's text is read (json_object) and checked against the schema (schema_errors). model_call.py makes the calls
through the analyst's own Claude Code session ($.model.complete, $.model.fork); agent_call.py makes the card check's,
which reads a picture, as a subagent of that session."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal

# `no_session`: no Claude Code session runs thimble in the workspace's folder, so no call could run (model_call.py,
# agent_call.py); `stopped`: the caller stopped the call
Status = Literal["ok", "refused", "rate_limited", "truncated", "no_tool_call", "timeout", "error", "no_session",
                 "stopped"]

# why a call could not run when no Claude Code session runs thimble in the folder (no module): the feature's notice
NO_SESSION = ("no Claude Code session runs thimble in this folder. Run `thimble` in the corpus folder, or open Claude "
              "Code there and type /thimble")


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
    cost_usd: float | None = None  # what the call cost, when known (a call through the analyst's session is theirs)
    session_id: str | None = None  # the card check's subagent's agent id; None for a model call
    attempts: int = 0  # requests sent, or agents started
    detail: str = ""  # one plain sentence for run.json, logs and notices; "" when ok
    text: str = ""  # the model's text from the final attempt, for no_tool_call/refused diagnostics
    # status == "truncated" only: the output tool's last call as far as it got before the cut (a cut-off tool_use is
    # parsed leniently); None when no tool call had started
    partial: dict | None = None
    # {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens} as the API counted them;
    # None when nothing said
    usage: dict | None = None
    # the model that refused the call when this result is its rerun on the refusal row's model; "" otherwise
    refused_by: str = ""


def json_object(text: str) -> tuple[dict[str, Any] | None, str]:
    """The JSON object a model's text holds: the text itself, a fenced block of it, or the span from its first `{` to
    its last `}`, an object followed by more text included. (None, why) when it holds none."""
    t = str(text or "").strip()
    cands = [m.group(1).strip() for m in re.finditer(r"```(?:json|JSON)?\s*\n(.*?)\n\s*```", t, re.S)]
    cands.append(t)
    i, j = t.find("{"), t.rfind("}")
    if 0 <= i < j:
        cands.append(t[i:j + 1])
    err = "no JSON object in the answer"
    for cand in cands:
        if "{" not in cand:
            continue
        try:
            got = json.loads(cand)
        except ValueError as e:
            err = f"invalid JSON: {e}"
            try:  # an object followed by more text
                got, _ = json.JSONDecoder().raw_decode(cand[cand.find("{"):])
            except ValueError:
                continue
        if isinstance(got, dict):
            return got, ""
        err = "the JSON is not an object"
    return None, err


def schema_errors(schema: dict[str, Any], answer: Any) -> str:
    """What about `answer` does not fit `schema`, '' when it fits."""
    import jsonschema  # noqa: PLC0415

    if not isinstance(answer, dict):
        return f"$: the answer must be a JSON object, not {type(answer).__name__}"
    found = sorted(jsonschema.Draft202012Validator(schema).iter_errors(answer), key=str)
    return "; ".join(f"{e.json_path}: {e.message}" for e in found[:5])
