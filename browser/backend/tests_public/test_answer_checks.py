"""Checks on Claude's answers in the chat (checks.py's run target ANSWERS, answer_comments.py): when main's turn ends
with an answer, each shown check that covers answers runs on its sentences, a follow-on start through the fake module,
and the chat lists the comments its add_comment stores, which Done dismisses."""
from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app import answer_comments, checks, config, subagents
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
IMPORTANT = "heads-up"
TURN = "a1b2c3d4"

ANSWER = ("The board holds 18 posts. Most came from agent-02, see [the log](events.jsonl#L4). The rest are\n"
          "status reports.\n\n"
          "- Agent-01 posted 3 times. It used `grep -c x.y` once.\n"
          "- Agent-03 posted [[2|board.jsonl#L7]] times? Yes.\n"
          "1. A numbered item, with e.g. a pause. Then more.\n\n"
          "```\nprint(1). Not a sentence.\n```\n\n"
          "| a | b |\n"
          "# A heading\n")


def _turn(text: str = ANSWER, turn: str = TURN) -> dict:
    return {"sid": "sid-1", "turn": turn, "rows": [{"uuid": "0", "text": text}, {"uuid": "1", "text": "Done."}],
            "at": time.time()}


@pytest.fixture()
def board(workspaces_tmp, monkeypatch):
    """Settings' checks row; the built-ins as in a new workspace, Heads up on and Judgment calls off, with Explainers
    turned off so that Heads up runs alone. The analyst added a sentence to the prompts of Heads up and Explainers, so
    their runs over answers are their agents, which these tests drive; on their own prompts they are the terminal's
    look."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    checks.edit(CORPUS, "explainers", shown=False)
    for cid in (IMPORTANT, "explainers"):
        checks.edit(CORPUS, cid, prompt=f"{checks.builtin(cid)['prompt']}\n\nThe analyst's own sentence.")


def _run(cid: str = IMPORTANT) -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(checks.ANSWERS) or {}


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


async def _answered(turn: dict | None = None) -> checks._Active:
    checks.answer_ended(CORPUS, turn or _turn())
    await _until(lambda: (CORPUS, IMPORTANT, checks.ANSWERS) in checks._active, "no run started after the answer")
    act = checks._active[(CORPUS, IMPORTANT, checks.ANSWERS)]
    await _until(lambda: act.agent or act.ended, "the run's agent never started")
    return act


async def test_an_answer_starts_the_shown_checks_whose_comments_the_chat_lists_and_dismisses(board, bridge):
    from app.main import app

    act = await _answered()
    [spawn] = bridge.ops("spawn")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on" and not act.notify
    assert _run()["covered"] == [p["ref"] for p in answer_comments.passages(_turn())]
    assert not _run("judgment") and not _run("explainers"), "the checks that are off do not run"
    task = (checks.work_dir(CORPUS, IMPORTANT, checks.ANSWERS) / checks.TASK_FILE).read_text()
    assert f"- answer:{TURN}#s1 The board holds 18 posts." in task
    # the check's comment on a passage, as its add_comment stores it
    p = answer_comments.passages(_turn())[0]
    cm, new = answer_comments.add(CORPUS, passage=p, text="Count again.", author=checks.AUTHOR, check=IMPORTANT, run="r1")
    assert new
    with TestClient(app) as client:
        got = client.get(f"/api/ws/{CORPUS}/answer-comments").json()
        assert [(x["id"], x["check_name"], x["quote"]) for x in got["comments"]] == [(cm["id"], "Heads up", p["text"])]
        assert client.post(f"/api/ws/{CORPUS}/answer-comments/{cm['id']}/dismiss").status_code == 200
        assert client.get(f"/api/ws/{CORPUS}/answer-comments").json()["comments"] == []
