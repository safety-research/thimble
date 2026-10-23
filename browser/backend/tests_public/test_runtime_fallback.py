"""A model fallback in a reply on the Messages API (runtime_api.py): when the API answers with another model than the one
asked for, the reply holds a `fallback` block whose `from` the SDK names `from_`. The conversation keeps the API's own
field names, so the next request sends the block back as the API wrote it; a conversation saved before that is read
back in them too. No model is called."""
from __future__ import annotations

import json
from types import SimpleNamespace

from anthropic.types.beta import BetaFallbackBlock, BetaTextBlock

from app import runtime_api

FALLBACK = {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"},
            "trigger": {"category": "cyber", "type": "refusal"}}


def test_a_reply_s_fallback_block_keeps_the_api_s_field_names():
    final = SimpleNamespace(content=[BetaTextBlock.model_validate({"type": "text", "text": "Here is the overview."}),
                                     BetaFallbackBlock.model_validate(FALLBACK)])
    text, fallback = runtime_api.reply_blocks(final)
    assert text == {"type": "text", "text": "Here is the overview."}
    assert fallback == FALLBACK and "from_" not in fallback


def test_a_conversation_saved_with_the_sdk_s_name_is_read_back_in_the_api_s(tmp_path):
    saved = [{"role": "user", "content": "What are these episodes?"},
             {"role": "assistant", "content": [{"type": "text", "text": "They are"},
                                               {**{k: v for k, v in FALLBACK.items() if k != "from"}, "from_": FALLBACK["from"]}]}]
    path = tmp_path / "main.api.json"
    path.write_text(json.dumps(saved), encoding="utf-8")
    messages = runtime_api._load(path)
    assert messages[1]["content"][1] == FALLBACK
    assert messages[0] == saved[0]
