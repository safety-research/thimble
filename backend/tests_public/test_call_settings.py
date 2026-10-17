"""Every structured model call runs as a subagent of main (agent_call.py) at the model and effort Settings shows for
its role (GET /settings `models`, config.call_settings), defaults included, so neither comes from the analyst's Claude
Code model or effort: the prompt label's batches and its draft, view fit, the viewer suggestion and a program's ask.
The card check's reading is checked the same way in test_agent_call.py."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from app import agent_call, concepts, harness, ledger, subagent_files as sf, subagents, tools, userconf, view_fit, views
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


async def _until(cond, what: str) -> None:
    for _ in range(500):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


@pytest.mark.parametrize("conf", [
    {},
    {"agents": {"labels": {"model": "claude-sonnet-5", "effort": "medium", "fast": True},
                "cardCheck": {"effort": "low", "fast": False}, "suggest": {"model": "claude-haiku-4-5-20251001"},
                "checks": {"effort": "max"}, "refusal": {"off": True}}},
], ids=["defaults", "configured"])
async def test_each_structured_call_runs_as_a_subagent_at_what_settings_shows_for_its_role(
        conf, tmp_path, data_tmp, workspaces_tmp, bridge, monkeypatch):
    """With thimble's config null (the defaults Settings shows resolved) and with some roles set, each call starts one
    `thimble:call` agent whose model and effort are its role's row in GET /settings (no effort for a model Claude Code
    runs without one), with a task line and a drop reason of its own, and gets the answer its agent sends."""
    monkeypatch.setattr(agent_call, "POLL_S", 0.01)
    sf.ensure(subagents.ws(CORPUS))
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(conf))
    shown = ledger.get_settings(CORPUS)["models"]
    for n, (what, role, key, call) in enumerate(_calls(tmp_path)):
        task = asyncio.create_task(call())
        await _until(lambda: len(bridge.ops("spawn")) > n, f"{what}: no agent started")
        spawn = bridge.ops("spawn")[n]
        row = shown[role]
        assert row["model"] and row["effort"], (what, row)
        assert spawn["values"]["model"] == row["model"], what
        assert spawn["values"].get("effort", "") == subagents.values_for(CORPUS, "call", row)["effort"], what
        assert spawn["description"].startswith("thimble ") and spawn["drop"].startswith("thimble "), what
        await _until(lambda: len(subagents.agents_of(CORPUS, role="call")) > n, f"{what}: no agent registered")
        aid, a = list(subagents.agents_of(CORPUS, role="call").items())[n]
        tid = f"toolu_answer_{n}"
        sf.add_caller(subagents.ws(CORPUS), tid, aid, "thimble:call")
        sent = await tools.call(CORPUS, "send_answer", {"answer": OUTPUTS[key]}, session=str(a["key"]),
                                tool_use_id=tid)
        assert not sent.is_error, (what, sent.text)
        res = await asyncio.wait_for(task, 5)
        assert res == "yes" if what.startswith("ask") else res.status == "ok", (what, res)
