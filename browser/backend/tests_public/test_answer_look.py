"""Heads up and Explainers on Claude's answers are the terminal's look (look.py, checks._looked): when main's turn ends
with an answer, the two checks' runs share one fork of main whose prompt is the terminal's own frame and lens texts, so
the heads-up and the explainers are decided together, as the terminal decides them; each mark is its check's comment
on its words, a heads-up first and no explainer on its words. A check that is off has no lens in the look, one whose
prompt the analyst changed runs as its agent, and a look that fails ends each run failed with its reason. The fork is a
stand-in (marks.run_fork); the composer and the placing are the terminal's own code (look_of.mjs)."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

from app import answer_comments, checks, config, marks
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TURN = "a1b2c3d4"
ANSWER = ("The clean stage drops about 400 trips a night. It drops a trip that lasted less than 90 seconds, which the "
          "config calls a docking test.")
REPLY = {"glosses": [{"term": "docking test", "body": "A ride that ends where it began within seconds.",
                      "here": "[The config](config/pipeline.yaml#L8-9) names it."},
                     {"term": "about 400 trips", "body": "The median count it drops.", "here": "x"}],
         "heads": {"term": "about 400 trips", "title": "The 400 counts every rule together",
                   "bullets": ["The logs give one total a night, [406 on Sep 1](runs/2026-09-01.jsonl#L2)."]}}


def _turn() -> dict:
    return {"sid": "sid-1", "turn": TURN, "rows": [{"uuid": "0", "text": ANSWER}], "at": time.time()}


@pytest.fixture()
def forks(workspaces_tmp, monkeypatch):
    """Settings' checks row; Heads up and Explainers on, as in a new workspace; main at a finished turn; each fork of
    main kept with its prompt and answering `answer` (REPLY as JSON) or `error`."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    got: dict = {"prompts": [], "answer": json.dumps(REPLY), "error": None}

    async def fork(c, main, cut, prompt):
        got["prompts"].append(prompt)
        await asyncio.sleep(0.05)
        return {"answer": got["answer"], "calls": [], "error": got["error"]}

    monkeypatch.setattr(marks, "_main_now", lambda c: ({"sid": "sid-1", "model": "claude-opus-5-5"}, "cut"))
    monkeypatch.setattr(marks, "run_fork", fork)
    return got


def _run(cid: str) -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(checks.ANSWERS) or {}


async def _ended(*cids: str) -> None:
    for _ in range(500):
        if all(_run(cid).get("status") in ("done", "failed") for cid in cids):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"the runs of {cids} never ended: {[_run(cid) for cid in cids]}")


async def test_heads_up_and_explainers_mark_an_answer_in_one_look_as_the_terminal_does(forks, bridge, monkeypatch):
    from app import events

    posted: list[str] = []
    monkeypatch.setattr(events, "post", lambda c, kind, payload=None, **kw: posted.append(kind) or {})
    checks.answer_ended(CORPUS, _turn())
    await _ended("heads-up", "explainers")
    [prompt] = forks["prompts"]
    assert "You are thimble's observer." in prompt and "## Explainers" in prompt and "## Heads-ups" in prompt
    assert 'which begins "The clean stage drops about 400 trips a night.' in prompt
    assert prompt.rstrip().endswith('{"glosses": [], "heads": null}')
    assert not bridge.ops("spawn"), "no agent starts for either check"
    got = sorted((cm["check"], cm["words"], cm["text"], cm["details"]) for cm in answer_comments.open_comments(CORPUS))
    # the heads-up keeps its words; the explainer the reply gave on them is not added
    assert got == [("explainers", "docking test", "docking test: A ride that ends where it began within seconds.",
                    "The config [[config/pipeline.yaml#L8-L9]] names it."),
                   ("heads-up", "about 400 trips", "The 400 counts every rule together",
                    "The logs give one total a night, 406 on Sep 1 [[runs/2026-09-01.jsonl#L2]].")]
    assert (_run("heads-up")["status"], _run("explainers")["status"]) == ("done", "done")
    assert (_run("heads-up")["comments"], _run("explainers")["comments"]) == (1, 1)
    assert checks.CHECKED_KIND not in posted


async def test_a_check_that_is_off_has_no_lens_in_the_look(forks, bridge):
    checks.edit(CORPUS, "heads-up", shown=False)
    checks.answer_ended(CORPUS, _turn())
    await _ended("explainers")
    [prompt] = forks["prompts"]
    assert "## Explainers" in prompt and "## Heads-ups" not in prompt
    assert sorted((cm["check"], cm["words"]) for cm in answer_comments.open_comments(CORPUS)) == [
        ("explainers", "about 400 trips"), ("explainers", "docking test")]


async def test_a_check_whose_prompt_the_analyst_changed_runs_as_its_agent(forks, bridge):
    checks.edit(CORPUS, "explainers", prompt="Explain each station name.")
    checks.answer_ended(CORPUS, _turn())
    await _ended("heads-up")
    for _ in range(300):
        if bridge.ops("spawn"):
            break
        await asyncio.sleep(0.01)
    [prompt] = forks["prompts"]
    assert "## Heads-ups" in prompt and "## Explainers" not in prompt
    assert len(bridge.ops("spawn")) == 1, "Explainers, on the analyst's words, starts its agent"


async def test_a_look_that_fails_ends_each_run_failed_with_its_reason(forks, bridge):
    forks.update(answer="", error="it took too long")
    checks.answer_ended(CORPUS, _turn())
    await _ended("heads-up", "explainers")
    assert len(forks["prompts"]) == 1, "the two runs share one look"
    assert (_run("heads-up")["status"], _run("explainers")["status"]) == ("failed", "failed")
    assert _run("explainers")["summary"] == "it took too long"
    assert answer_comments.open_comments(CORPUS) == []
