"""Every structured model call runs through the analyst's Claude Code session's own client (model_call.py: the module's
$.model.complete, the fake bridge here) at the model and effort Settings shows for its role (GET /settings `models`,
config.call_settings), defaults included, so neither comes from the analyst's Claude Code model or effort: the prompt
label's batches and its draft, view fit, the viewer suggestion and a program's ask. None starts an agent. The card
check's reading, a subagent of main, is checked the same way in test_agent_call.py."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from app import concepts, harness, ledger, userconf, view_fit, views
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
CONCEPT = {"name": "tone", "unit": "record", "kind": "prompt", "spec": "Is the message friendly?", "description": "",
           "labels": ["friendly", "curt"], "marks": None}
OUTPUTS = {"labels": {"labels": [{"i": 1, "label": "friendly", "confidence": 0.8, "rationale": "warm"}]},
           "label": {"name": "Curt", "scope": "files", "kind": "prompt", "text": "Is it curt?",
                     "values": ["curt", "not curt"], "marks": "span"},
           "decision": {"fits": True, "reason": "Each record is a post."},
           "proposal": {"help": False, "name": "", "why": "", "arrangement": ""},
           "answer": {"text": "yes"}}


def _calls(tmp_path):
    """(what, its role among config.MODEL_ROLES, its answer's key in OUTPUTS, the call) for each structured call."""
    viewer = {"path": "a.cast", "size": "2.0 KB", "count": "3", "suffix": ".cast", "what": "its first line",
              "head": "{\"version\": 2}"}
    draft = {"description": "messages that sound curt", "records": {"paths": "runs/r1.jsonl", "path": "runs/r1.jsonl",
                                                                    "cut": "700", "lines": "Do it now."}}

    def asker(role):
        return lambda: harness.ask(SimpleNamespace(c=CORPUS, job=SimpleNamespace(model_role=role, work=tmp_path)),
                                   {"prompt": "Is it curt?"})

    return [
        ("labels", "labels", "labels",
         lambda: concepts.labels_task(CORPUS, concepts.label_input(CONCEPT, [("r#L1", "Thanks!")]))),
        ("label draft", "labels", "label", lambda: concepts.draft_task(CORPUS, draft)),
        ("view fit", "labels", "decision", lambda: view_fit.ask(CORPUS, "Does the Board view fit?", name="Board")),
        ("viewer suggestion", "suggest", "proposal", lambda: views.file_viewer_task(CORPUS, viewer)),
        ("ask (checks)", "checks", "answer", asker("checks")),
        ("ask (cardCheck)", "verify", "answer", asker("verify")),
    ]


@pytest.mark.parametrize("conf", [
    {},
    {"agents": {"labels": {"model": "claude-sonnet-5", "effort": "medium", "fast": True},
                "cardCheck": {"effort": "low", "fast": False}, "suggest": {"model": "claude-haiku-4-5-20251001"},
                "checks": {"effort": "max"}, "refusal": {"off": True}}},
], ids=["defaults", "configured"])
async def test_each_structured_call_is_a_completion_at_what_settings_shows_for_its_role(
        conf, tmp_path, data_tmp, workspaces_tmp, bridge):
    """With thimble's config null (the defaults Settings shows resolved) and with some roles set, each call is one
    completion through main's own client whose model and effort are its role's row in GET /settings, and gets the
    answer the model gave. No call starts an agent."""
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(conf))
    shown = ledger.get_settings(CORPUS)["models"]
    for n, (what, role, key, call) in enumerate(_calls(tmp_path)):
        bridge.respond = lambda op, args, key=key: {"text": json.dumps(OUTPUTS[key])}
        res = await asyncio.wait_for(call(), 5)
        assert res == "yes" if what.startswith("ask") else res.status == "ok", (what, res)
        op, args = bridge.calls[n]
        row = shown[role]
        assert row["model"] and row["effort"], (what, row)
        assert op == "complete" and (args["model"], args["effort"]) == (row["model"], row["effort"]), what
    assert not bridge.ops("spawn") and len(bridge.calls) == len(_calls(tmp_path))
