"""Every structured model call (model.structured) runs at the model, effort and fast mode Settings shows for its role
(GET /settings `models`, config.call_settings), defaults included, and passes all three to `claude`, so none comes from
the analyst's Claude Code model, effort, fast mode or Ultracode. A call without a model or an effort does not start."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, ToolResultBlock, ToolUseBlock, UserMessage

from app import card_check, concepts, config, harness, ledger, model, userconf, view_fit, views

CORPUS = "mini"
CONCEPT = {"name": "tone", "unit": "record", "kind": "prompt", "spec": "Is the message friendly?", "description": "",
           "labels": ["friendly", "curt"], "marks": None}
OUTPUTS = {"labels": {"labels": [{"i": 1, "label": "friendly", "confidence": 0.8, "rationale": "warm"}]},
           "label": {"name": "Curt", "scope": "files", "kind": "prompt", "text": "Is it curt?",
                     "values": ["curt", "not curt"], "marks": "span"},
           "critique": {"assessment": [{"problem": ""}] * 5, "question": "Q?", "code": "", "takeaway": "T."},
           "decision": {"fits": True, "reason": "Each record is a post."},
           "proposal": {"help": False, "name": "", "why": "", "arrangement": ""},
           "answer": {"text": "yes"}}


class Client:
    """An SDK client that answers with its call's output tool at once, keeping the options the call was built with."""

    def __init__(self, opts, seen):
        self.opts = opts
        seen.append(opts)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt, session_id="default"):
        pass

    async def receive_response(self):
        name = self.opts.allowed_tools[0]
        yield AssistantMessage(content=[ToolUseBlock(id="t1", name=name, input=OUTPUTS[name.rsplit("__", 1)[1]])],
                               model=str(self.opts.model))
        yield UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="recorded")])
        yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                            session_id="s1")

    async def interrupt(self):
        pass


@pytest.fixture()
def seen(monkeypatch) -> list:
    out: list = []
    monkeypatch.setattr(model, "_make_client", lambda opts: Client(opts, out))
    monkeypatch.setattr(card_check, "fit_image", lambda b: b)
    return out


def _calls(tmp_path):
    """(what, its role among config.MODEL_ROLES, the call) for each structured call thimble makes."""
    picture = tmp_path / "shot.png"
    picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)
    card = {"card": {"id": "c1", "kind": "code", "question": "How many curt replies?", "takeaway": "Two.",
                     "citations": "", "code": "print(2)", "context": "", "typed": "", "kept": ""},
            "picture": str(picture)}
    viewer = {"path": "a.cast", "size": "2.0 KB", "count": "3", "suffix": ".cast", "what": "its first line",
              "head": "{\"version\": 2}"}
    draft = {"description": "messages that sound curt", "records": {"paths": "runs/r1.jsonl", "path": "runs/r1.jsonl",
                                                                    "cut": "700", "lines": "Do it now."}}

    def asker(role):
        return lambda: harness.ask(SimpleNamespace(c=CORPUS, job=SimpleNamespace(model_role=role, work=tmp_path)),
                                   {"prompt": "Is it curt?"})

    return [
        ("labels", "labels", lambda: concepts.labels_task(CORPUS, concepts.label_input(CONCEPT, [("r#L1", "Thanks!")]))),
        ("label draft", "labels", lambda: concepts.draft_task(CORPUS, draft)),
        ("view fit", "labels", lambda: view_fit.ask(CORPUS, "Does the Board view fit?")),
        ("card check", "verify", lambda: card_check.check_task(CORPUS, card)),
        ("viewer suggestion", "suggest", lambda: views.file_viewer_task(CORPUS, viewer)),
        ("ask (checks)", "checks", asker("checks")),
        ("ask (cardCheck)", "verify", asker("verify")),
    ]


@pytest.mark.parametrize("conf", [
    {},
    {"agents": {"labels": {"model": "claude-sonnet-5", "effort": "medium", "fast": True},
                "cardCheck": {"effort": "low", "fast": False}, "suggest": {"model": "claude-haiku-4-5-20251001"},
                "checks": {"effort": "max"}, "refusal": {"off": True}}},
], ids=["defaults", "configured"])
async def test_each_structured_call_runs_at_what_settings_shows_for_its_role(conf, tmp_path, data_tmp, workspaces_tmp,
                                                                            seen, monkeypatch):
    """With thimble's config null (the defaults Settings shows resolved) and with some roles set, each call's `claude`
    gets --model and --effort, CLAUDE_CODE_EFFORT_LEVEL and fastMode equal to its role's row in GET /settings (no
    effort for a model Claude Code runs without one), and ultracode off, whatever THIMBLE_MODEL_SPEED, the speed of a call that names none, says."""
    path = userconf.global_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(conf))
    monkeypatch.setenv("THIMBLE_MODEL_SPEED", "fast")
    shown = ledger.get_settings(CORPUS)["models"]
    for what, role, call in _calls(tmp_path):
        before = len(seen)
        res = await call()
        assert res == "yes" if what.startswith("ask") else res.status == "ok", (what, res)
        row = shown[role]
        assert row["model"] and row["effort"], (what, row)
        opts = seen[before]
        settings = json.loads(opts.settings)
        if config.has_effort(row["model"]):
            assert (opts.model, opts.effort) == (row["model"], row["effort"]), what
            assert settings["env"]["CLAUDE_CODE_EFFORT_LEVEL"] == row["effort"], what
        else:  # Haiku runs with no effort (config.NO_EFFORT_MODELS)
            assert (opts.model, opts.effort) == (row["model"], None) and "env" not in settings, what
        assert settings["fastMode"] is row["fast"] and settings["ultracode"] is False, what


async def test_a_call_without_a_model_or_an_effort_does_not_start(seen):
    """A call that names no model or no effort ends `error` before any `claude` starts, rather than run at the
    analyst's own model or effort."""
    tool = model.ToolSpec(name="answer", description="d", input_schema=harness.ANSWER_TOOL)
    for model_name, effort in (("", "low"), ("claude-opus-5-5", ""), ("claude-opus-5-5", None)):
        res = await model.structured("hi", tool=tool, model=model_name, effort=effort, speed="standard", refusal=None,
                                     cwd="/tmp")
        assert res.status == "error" and "no model or no effort" in res.detail
    assert seen == []
