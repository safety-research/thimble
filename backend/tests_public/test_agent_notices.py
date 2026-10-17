"""Every failure of thimble's agents reaches the analyst where they are looking (notices.py): a start that did not
happen and a run that ended failed (subagents.py), a view whose build failed (dev.py), a report check that failed
(checks.py), a card check that failed by itself (card_check.py) and a label run that failed (concepts.py). Each is one
open notice under the agent's key, with its fix and, for an agent with a chat, Open on that chat; a later start or
success clears it. The module is the fake bridge (subagent_fakes)."""
from __future__ import annotations


import pytest

from app import agents, config, notices, subagents
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
BLOCK = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup)."
SAFEGUARDS = "Claude's safeguards stopped its request; rephrase or narrow the request and try again"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, monkeypatch):
    rows = {r: {"model": "claude-opus-5-5", "effort": "high", "fast": False}
            for r in ("orient", "subagents", "critic", "writer", "checks", "dev", "labels", "verify")}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    yield


def _open(key: str, c: str = CORPUS) -> dict | None:
    return next((n for n in notices.open_notices(c) if n.get("key") == key), None)


# --------------------------------------------------------------------------- subagents.py


async def test_a_run_that_failed_is_told_with_open_on_its_chat_and_a_new_run_clears_it(bridge):
    ans = await subagents.start_job(CORPUS, "writer", "writer:report", "w", {}, subagents.CLICK,
                                    chat={"title": "Write report", "doc": "report"})
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    subagents.run_ended(CORPUS, ans.agent_id, "failed", BLOCK, source="module")
    n = _open("agent:writer:report")
    assert n["text"] == f"The writer of report failed: {SAFEGUARDS}." and n["chat"] == chat
    rows = [r for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r["type"] == notices.TYPE]
    assert [r["id"] for r in rows] == [n["id"]], "a row in the writer's own chat"
    subagents.run_again(CORPUS, ans.agent_id, "coordinator")
    assert _open("agent:writer:report") is None
    subagents.run_ended(CORPUS, ans.agent_id, "stopped", "", source="module")
    assert notices.open_notices(CORPUS) == [], "a stop is no failure"


async def test_a_failed_orientation_s_notice_runs_it_again(bridge):
    """Bug hunt C18: the notice of an orientation both models refused offered nothing but its thread."""
    ans = await subagents.start_job(CORPUS, "orientation", "orient", "o", {}, subagents.CLICK, chat={"title": "Orientation"})
    subagents.run_ended(CORPUS, ans.agent_id, "failed", BLOCK, source="module")
    n = _open("agent:orient")
    assert n["text"] == f"The orientation failed: {SAFEGUARDS}."
    assert n["action"] == {"label": "Run again", "do": "orient-again"}, n["action"]
