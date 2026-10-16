"""Checks on Claude's answers (checks.py's run target ANSWERS, answer_comments.py): an answer's passages are its
sentences, split from paragraphs and list items and never inside a link or a code span, each with its offsets in its
row's raw text; after a data turn each shown check that covers answers runs on the answer, a follow-on start through
the fake module, and its add_comment stores the passage's quote and offsets; a non-data turn, or the checks feature off,
starts none; dismiss and reopen, the state surface and the routes; a run over answers tells main nothing when it ends;
a comment's color is its check's colour."""
from __future__ import annotations

import asyncio
import sys
import time
import types

import pytest

from app import answer_comments, checks, config, subagents, tools
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
IMPORTANT = "important-details"
TURN = "u-first-row"

ANSWER = ("The board holds 18 posts. Most came from agent-02, see [the log](events.jsonl#L4). The rest are\n"
          "status reports.\n\n"
          "- Agent-01 posted 3 times. It used `grep -c x.y` once.\n"
          "- Agent-03 posted [[2|board.jsonl#L7]] times? Yes.\n"
          "1. A numbered item, with e.g. a pause. Then more.\n\n"
          "```\nprint(1). Not a sentence.\n```\n\n"
          "| a | b |\n"
          "# A heading\n")


def _turn(text: str = ANSWER, tools_: list | None = None, sid: str = "sid-1", turn: str = TURN) -> dict:
    return {"sid": sid, "turn": turn, "rows": [{"uuid": turn, "text": text}, {"uuid": "u-second", "text": "Done."}],
            "tools": tools_ if tools_ is not None else [{"name": "Read", "input": {"file_path": "board.jsonl"}}],
            "at": time.time()}


@pytest.fixture()
def board(workspaces_tmp, mini_dir, monkeypatch):
    """Settings' checks row; Important details on, as in a new workspace, the other built-ins off."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    # thimble is on in a session and no press came: the local transport (C11), so the acts run here, not on a server
    from terminal_fakes import write_launch  # noqa: PLC0415
    write_launch(config.workspace_dir(CORPUS))


@pytest.fixture()
def features(monkeypatch):
    """The checks feature switch (features.auto, C6): the core lane's module, or a stand-in where it is not there."""
    try:
        from app import features as mod  # noqa: PLC0415
    except ImportError:
        mod = types.ModuleType("app.features")
        monkeypatch.setitem(sys.modules, "app.features", mod)
        import app  # noqa: PLC0415

        monkeypatch.setattr(app, "features", mod, raising=False)
    off: set[str] = set()
    monkeypatch.setattr(mod, "auto", lambda c, kind: kind not in off, raising=False)
    return off


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


async def _comment(act: checks._Active, ref: str, text: str, tid: str, details: str | None = None):
    sf.add_caller(config.workspace_dir(CORPUS), tid, act.agent, "thimble:check")
    args = {"ref": ref, "text": text, **({"details": details} if details is not None else {})}
    return await tools.call(CORPUS, "add_comment", args, session=checks.session_key(IMPORTANT, checks.ANSWERS),
                            tool_use_id=tid)


async def test_a_data_turn_starts_the_shown_checks_that_cover_answers(board, bridge, features):
    act = await _answered()
    [spawn] = bridge.ops("spawn")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert spawn["what"] == f"{IMPORTANT} on {checks.ANSWERS}"
    assert not act.notify
    rec = _run()
    assert rec["covered"] == [p["ref"] for p in answer_comments.passages(_turn())]
    assert not _run("judgment") and not _run("unverified"), "the checks that are off do not run"
    task = (checks.work_dir(CORPUS, IMPORTANT, checks.ANSWERS) / checks.TASK_FILE).read_text()
    assert answer_comments.TASK_HEADING in task
    assert f"- answer:{TURN}#s1 The board holds 18 posts." in task
    assert "Comment on a passage only when the reader would likely miss" in task
    running = answer_comments.state(CORPUS)["running"]
    assert running == [{"check": IMPORTANT, "check_name": "Important details", "turn": TURN}]


async def test_add_comment_on_an_answer_stores_its_quote_and_offsets_and_refuses_what_it_does_not_cover(board, bridge,
                                                                                                        features):
    act = await _answered()
    ref = f"answer:{TURN}#s2"
    res = await _comment(act, ref, "agent-02 posted 6 of 18, not most.", "toolu_a1",
                         details="The board counts 6 posts by agent-02 [[board.jsonl#L3]].")
    assert not res.is_error, res.text
    [cm] = answer_comments.open_comments(CORPUS)
    p = answer_comments.passage_of(CORPUS, ref)
    assert (cm["ref"], cm["row"], cm["start"], cm["end"], cm["quote"]) == (ref, TURN, p["start"], p["end"], p["text"])
    assert ANSWER[cm["start"]:cm["end"]] == cm["quote"]
    assert cm["text"] == "agent-02 posted 6 of 18, not most." and cm["check"] == IMPORTANT and cm["run"] == act.run
    res = await _comment(act, f"answer:{TURN}#s99", "No such sentence.", "toolu_a2")
    assert res.is_error and "not among the passages" in res.text
    res = await _comment(act, "report:report#x", "Not an answer.", "toolu_a3")
    assert res.is_error
    assert _run()["comments"] == 1
