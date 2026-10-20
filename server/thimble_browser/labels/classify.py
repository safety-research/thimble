"""A prompt label's model calls: the request for one batch of records and what its reply says of each record.

The prompt is the terminal plugin's label classifier (prompts/terminal/labels/v2.md, the shared part `labels`), so a
label reads the same in both products. The words before its records are the system prompt, the same on every call of a
run, so the calls after the first read them from the prompt cache; the records, each under `### record <n>`, are the
user message. The reply is JSON in the form the schema gives.
"""
from __future__ import annotations

import json
from typing import Any

from .. import prompts

MODEL = "claude-sonnet-5-5"  # the terminal's labels run on Sonnet at low effort (lean/verbs/label/verb.json)
EFFORT = "low"
MAX_TOKENS = 16000
BATCH_ITEMS = 50  # records per call
BATCH_CHARS = 40_000  # or fewer, when their texts add up to this many characters
RECORD_CHARS = 30_000  # the most of one record a call reads
REASON = ', "reason": one short sentence naming the words in the record that decided the value'


def system_prompt(concept: dict[str, Any]) -> str:
    """The classifier's instructions for one label: the shared part with the label's name, definition and values."""
    definition = (concept.get("description") or concept.get("spec") or "").strip() or "(no definition was given)"
    vals = {"{{NAME}}": concept["name"], "{{DEFINITION}}": definition, "{{VALUES}}": ", ".join(concept["labels"]),
            "{{REASON_FIELD}}": REASON if concept.get("comment") else ""}
    text = prompts.shared("labels")
    for k, v in vals.items():
        text = text.replace(k, v)
    return text.strip()


def records_text(texts: list[str]) -> str:
    return "\n\n".join(f"### record {i}\n{str(t or '').strip()[:RECORD_CHARS]}" for i, t in enumerate(texts, 1))


def schema(concept: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {"type": "object", "properties": {
        "i": {"type": "integer"}, "value": {"type": "string", "enum": list(concept["labels"])},
        "confidence": {"type": "number"}}, "required": ["i", "value", "confidence"], "additionalProperties": False}
    if concept.get("comment"):
        item["properties"]["reason"] = {"type": "string"}
        item["required"].append("reason")
    return {"type": "object", "properties": {"records": {"type": "array", "items": item}}, "required": ["records"],
            "additionalProperties": False}


def batches(units: list[Any]) -> list[list[Any]]:
    """The units in calls of up to BATCH_ITEMS records and BATCH_CHARS characters."""
    out: list[list[Any]] = []
    cur: list[Any] = []
    size = 0
    for u in units:
        n = min(len(u.text or ""), RECORD_CHARS)
        if cur and (len(cur) >= BATCH_ITEMS or size + n > BATCH_CHARS):
            out.append(cur)
            cur, size = [], 0
        cur.append(u)
        size += n
    if cur:
        out.append(cur)
    return out


def _entries(reply: str) -> list[Any] | None:
    s = (reply or "").strip()
    tries = [s]
    a, b = s.find("{"), s.rfind("}")
    if a >= 0 and b > a:
        tries.append(s[a:b + 1])
    a, b = s.find("["), s.rfind("]")
    if a >= 0 and b > a:
        tries.append(s[a:b + 1])
    for t in tries:
        try:
            v = json.loads(t)
        except ValueError:
            continue
        if isinstance(v, list):
            return v
        if isinstance(v, dict) and isinstance(v.get("records"), list):
            return v["records"]
    return None


def answers(reply: str, n: int, values: list[str]) -> tuple[dict[int, dict[str, Any]], dict[int, str]]:
    """({record index: {value, confidence, reason?}}, {record index: why it has no value}) for a batch of `n` records;
    a value off the list in another case is the value it names."""
    got: dict[int, dict[str, Any]] = {}
    failed: dict[int, str] = {}
    arr = _entries(reply)
    if arr is None:
        return {}, {k: "the reply held no JSON of values" for k in range(n)}
    by_i: dict[int, dict] = {}
    for e in arr:
        if isinstance(e, dict):
            try:
                i = int(e.get("i", e.get("index")))
            except (TypeError, ValueError):
                continue
            by_i.setdefault(i, e)
    for k in range(n):
        e = by_i.get(k + 1)
        if e is None:
            failed[k] = "the reply gave this record no value"
            continue
        raw = e.get("value", e.get("label"))
        v = next((x for x in values if x == raw), None) or next(
            (x for x in values if isinstance(raw, str) and x.lower() == raw.strip().lower()), None)
        if v is None:
            failed[k] = f"the reply gave {json.dumps(raw)}, which is not one of {', '.join(values)}"
            continue
        try:
            c = max(0.0, min(1.0, float(e.get("confidence"))))
        except (TypeError, ValueError):
            c = None
        got[k] = {"value": v, "confidence": c, **({"reason": str(e["reason"])[:300]} if e.get("reason") else {})}
    return got, failed
