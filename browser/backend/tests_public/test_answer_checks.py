"""Checks on Claude's answers in the chat (checks.py's run target ANSWERS, answer_comments.py): an answer's passages are
its sentences, split from paragraphs and list items and never inside a link or a code span, each with its offsets in its
row's text; when main's turn ends with an answer each shown check that covers answers runs on it, a follow-on start
through the fake module, and its add_comment stores the passage's quote and offsets; Important details covers answers
by default and a stored copy from before reads so, unless the analyst set its Show in; a check turned off, or whose Chat
is unchecked, leaves nothing in the chat; a run over answers tells main nothing when it ends and supersedes its
check's earlier comments; the routes."""
from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app import answer_comments, checks, config, subagents, tools
from app import subagent_files as sf
from app.ledger import write_json
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
IMPORTANT = "important-details"
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
    """Settings' checks row; the built-ins as in a new workspace: Important details on, the other two off."""
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)


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


def test_an_answer_s_passages_are_its_sentences_with_their_offsets():
    ps = answer_comments.passages(_turn())
    texts = [p["text"] for p in ps]
    assert texts[:4] == ["The board holds 18 posts.",
                         "Most came from agent-02, see [the log](events.jsonl#L4).",
                         "The rest are\nstatus reports.", "Agent-01 posted 3 times."]
    assert "It used `grep -c x.y` once." in texts and "Agent-03 posted [[2|board.jsonl#L7]] times?" in texts
    assert not any("print(1)" in t or "| a |" in t for t in texts), "code and tables hold no passage"
    assert texts[-1] == "Done." and ps[-1]["row"] == "1"
    assert [p["ref"] for p in ps] == [f"answer:{TURN}#s{n}" for n in range(1, len(ps) + 1)]
    assert all(ANSWER[p["start"]:p["end"]] == p["text"] for p in ps if p["row"] == "0")


def test_important_details_covers_the_chat_and_the_other_built_ins_do_not(board):
    assert checks.covers(checks.read(CORPUS, IMPORTANT), "answers")
    assert not checks.covers(checks.read(CORPUS, "judgment"), "answers")
    assert not checks.covers(checks.read(CORPUS, "unverified"), "answers")
    # a copy stored before the chat was covered reads as covering it, until the analyst sets its Show in
    stored = {**checks.builtin(IMPORTANT), "covers": ["documents", "cards"], "shown": True}
    checks._path(CORPUS, IMPORTANT).parent.mkdir(parents=True, exist_ok=True)
    write_json(checks._path(CORPUS, IMPORTANT), stored)
    assert checks.read(CORPUS, IMPORTANT)["covers"] == ["documents", "cards", "answers"]
    checks.edit(CORPUS, IMPORTANT, covers=["documents", "cards"])
    assert checks.read(CORPUS, IMPORTANT)["covers"] == ["documents", "cards"]


async def test_an_answer_starts_the_shown_checks_that_cover_answers(board, bridge):
    act = await _answered()
    [spawn] = bridge.ops("spawn")
    assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
    assert not act.notify
    assert _run()["covered"] == [p["ref"] for p in answer_comments.passages(_turn())]
    assert not _run("judgment") and not _run("unverified"), "the checks that are off do not run"
    task = (checks.work_dir(CORPUS, IMPORTANT, checks.ANSWERS) / checks.TASK_FILE).read_text()
    assert answer_comments.TASK_HEADING in task
    assert f"- answer:{TURN}#s1 The board holds 18 posts." in task
    assert "Comment on a passage only when the reader would likely miss" in task
    assert answer_comments.state(CORPUS)["running"] == [{"check": IMPORTANT, "check_name": "Important details",
                                                         "turn": TURN}]


async def test_a_check_s_first_run_on_answers_reads_the_new_answer_alone(board, bridge):
    answer_comments.store_answer(CORPUS, {**_turn(turn="older"), "at": time.time() - 60})
    await _answered()
    assert {r.split("#", 1)[0] for r in _run()["covered"]} == {f"answer:{TURN}"}


async def test_add_comment_on_an_answer_stores_its_quote_and_offsets_and_refuses_what_it_does_not_cover(board, bridge):
    act = await _answered()
    ref = f"answer:{TURN}#s2"
    res = await _comment(act, ref, "agent-02 posted 6 of 18, not most.", "toolu_a1",
                         details="The board counts 6 posts by agent-02 [[board.jsonl#L3]].")
    assert not res.is_error, res.text
    [cm] = answer_comments.open_comments(CORPUS)
    p = answer_comments.passage_of(CORPUS, ref)
    assert (cm["ref"], cm["turn"], cm["row"], cm["quote"]) == (ref, TURN, "0", p["text"])
    assert ANSWER[cm["start"]:cm["end"]] == cm["quote"]
    assert cm["check"] == IMPORTANT and cm["run"] == act.run
    res = await _comment(act, f"answer:{TURN}#s99", "No such sentence.", "toolu_a2")
    assert res.is_error and "not among the passages" in res.text
    assert _run()["comments"] == 1


async def test_a_check_off_or_out_of_the_chat_leaves_nothing_there_and_its_comments_come_back(board, bridge):
    act = await _answered()
    res = await _comment(act, f"answer:{TURN}#s2", "agent-02 posted 6 of 18, not most.", "toolu_b1")
    assert not res.is_error, res.text
    assert [x["check"] for x in answer_comments.state(CORPUS)["comments"]] == [IMPORTANT]
    checks.edit(CORPUS, IMPORTANT, shown=False)
    assert answer_comments.state(CORPUS) == {"comments": [], "running": []}
    checks.edit(CORPUS, IMPORTANT, shown=True)
    assert len(answer_comments.state(CORPUS)["comments"]) == 1
    checks.edit(CORPUS, IMPORTANT, covers=["documents", "cards"])
    assert answer_comments.state(CORPUS)["comments"] == []
    assert len(answer_comments.open_comments(CORPUS)) == 1, "the comment stays in the store"


async def test_a_run_over_answers_tells_main_nothing_and_its_end_supersedes_its_earlier_comments(board, bridge,
                                                                                                 monkeypatch):
    from app import events

    posted: list[str] = []
    monkeypatch.setattr(events, "post", lambda c, kind, payload=None, **kw: posted.append(kind) or {})
    first = await _answered()
    res = await _comment(first, f"answer:{TURN}#s1", "The board holds 19 posts.", "toolu_c1")
    assert not res.is_error, res.text
    subagents.run_ended(CORPUS, first.agent, "done", "Commented on 1 passage.", source="handback")
    await _until(lambda: _run()["status"] == "done", "the run never ended")
    assert len(_run()["seen"]) == len(first.fps)
    rec = await checks.start_run(CORPUS, IMPORTANT, checks.ANSWERS, force=True, notify=True, route="click")
    assert rec is not None and not rec["notify"]
    second = checks._active[(CORPUS, IMPORTANT, checks.ANSWERS)]
    await _until(lambda: second.agent or second.ended, "the second run never started")
    subagents.run_ended(CORPUS, second.agent, "done", "Commented on 0 passages.", source="handback")
    await _until(lambda: _run()["run"] == second.run and _run()["status"] == "done", "the second run never ended")
    [cm] = answer_comments._read(CORPUS)
    assert cm["status"] == answer_comments.SETTLED and cm["superseded_by"] == second.run
    assert checks.CHECKED_KIND not in posted


def test_the_routes_list_dismiss_and_reopen_a_comment(board):
    from app.main import app

    p = answer_comments.passages(_turn())[0]
    answer_comments.store_answer(CORPUS, _turn())
    cm, new = answer_comments.add(CORPUS, passage=p, text="Count again.", author=checks.AUTHOR, check=IMPORTANT, run="r1")
    assert new
    with TestClient(app) as client:
        got = client.get(f"/api/ws/{CORPUS}/answer-comments").json()
        assert [(x["id"], x["check_name"], x["quote"]) for x in got["comments"]] == [(cm["id"], "Important details",
                                                                                      p["text"])]
        assert client.post(f"/api/ws/{CORPUS}/answer-comments/{cm['id']}/dismiss").status_code == 200
        assert client.get(f"/api/ws/{CORPUS}/answer-comments").json()["comments"] == []
        assert client.post(f"/api/ws/{CORPUS}/answer-comments/{cm['id']}/reopen").status_code == 200
        assert len(client.get(f"/api/ws/{CORPUS}/answer-comments").json()["comments"]) == 1
        assert client.post(f"/api/ws/{CORPUS}/answer-comments/nope/dismiss").status_code == 404
