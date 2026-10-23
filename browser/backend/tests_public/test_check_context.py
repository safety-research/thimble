"""What a run of Heads up or Explainers reads (checks.first_message, LENS_CHECKS): main's conversation in brief, turn by
turn, its answers and the cards each turn made with their question and takeaway, no call of another turn; for a run over
an answer, what that answer rests on (its turn's calls with their results, and what it cites); and the digest of what the
check already said, heads-ups for Heads up and terms for Explainers, without the comments the run replaces. Every other
check reads the whole conversation with its calls, as before."""
from __future__ import annotations

import json
import time

import pytest

from app import answer_comments, checks, config, context

CORPUS = "mini"
CARD = "abc12345"


def _rec(role: str, content) -> dict:
    return {"type": role, "message": {"role": role, "content": content}}


def _call(i: str, name: str, inp: dict) -> dict:
    return _rec("assistant", [{"type": "tool_use", "id": i, "name": name, "input": inp}])


def _result(i: str, text: str) -> dict:
    return _rec("user", [{"type": "tool_result", "tool_use_id": i, "content": text}])


FIRST = "The board holds 18 posts [[card:abc12345]]."
SECOND = "Agent-02 posted most, 7 of the 18 posts [[board.jsonl#L7]]."
TRANSCRIPT = [
    _rec("user", "How many posts are on the board?"),
    _call("t1", "Bash", {"command": "wc -l board.jsonl"}),
    _result("t1", "18 board.jsonl OLD-TURN-RESULT"),
    _call("t2", "mcp__plugin_thimble_thimble__add_card", {"question": "How many posts?", "code": "x"}),
    _result("t2", "(rendered a chart/table; thimble shows it as [[card:abc12345]])"),
    _rec("assistant", [{"type": "text", "text": FIRST}]),
    _rec("user", "Who posted the most?"),
    _call("t3", "Bash", {"command": "cut -d, -f4 board.jsonl | sort | uniq -c"}),
    _result("t3", "7 agent-02\n5 agent-01 NEW-TURN-RESULT"),
    _rec("assistant", [{"type": "text", "text": SECOND}]),
]


@pytest.fixture()
def ws(workspaces_tmp, monkeypatch, tmp_path):
    config.workspace_dir(CORPUS).mkdir(parents=True, exist_ok=True)
    path = tmp_path / "main.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in TRANSCRIPT), encoding="utf-8")
    monkeypatch.setattr(context, "transcript_path", lambda c: path)
    monkeypatch.setattr(context, "_cards_by_id", lambda c: {CARD: {"id": CARD, "kind": "table", "title": "How many posts?",
                                                                  "takeaway": "The board holds 18 posts."}})
    first = answer_comments.store_answer(CORPUS, {"sid": "s", "turn": "turn0001", "rows": [{"uuid": "0", "text": FIRST}],
                                                  "at": time.time() - 60})
    second = answer_comments.store_answer(CORPUS, {"sid": "s", "turn": "turn0002", "rows": [{"uuid": "0", "text": SECOND}],
                                                   "at": time.time()})
    return first, second


def _say(cid: str, passage: dict, text: str) -> None:
    answer_comments.add(CORPUS, passage=passage, text=text, author=checks.AUTHOR, check=cid, run="r0")


def test_a_heads_up_run_reads_the_conversation_in_brief_what_the_answer_rests_on_and_the_heads_ups_given(ws):
    first, second = ws
    _say("heads-up", answer_comments.passages(first)[0], "The 18 counts the deleted posts too.")
    _say("explainers", answer_comments.passages(first)[0], "The board is the run's message board.")
    cover = answer_comments.passages(second)
    _say("heads-up", cover[0], "A comment this run replaces.")
    text = checks.first_message(CORPUS, checks.read(CORPUS, "heads-up"), checks.ANSWERS, cover)
    brief = text.split("## The conversation in brief", 1)[1].split("## The cards", 1)[0]
    assert "How many posts are on the board?" in brief and FIRST in brief and SECOND in brief
    assert "card:abc12345 · table · How many posts?\n  takeaway: The board holds 18 posts." in brief
    assert "### Turn 2 · the answer you check" in brief and "### Turn 1\n" in brief
    assert "OLD-TURN-RESULT" not in text and "## The conversation\n" not in text
    rests = text.split("## What the answer rests on", 1)[1].split("## Heads-ups already given", 1)[0]
    assert "NEW-TURN-RESULT" in rests and "uniq -c" in rests and "- board.jsonl#L7" in rests
    heads = text.split("## Heads-ups already given", 1)[1].split("## Your task", 1)[0]
    assert '- The 18 counts the deleted posts too. (on answer:turn0001#s1: "The board holds 18 posts' in heads
    assert "message board" not in heads and "A comment this run replaces." not in heads
    assert "## Terms already explained" not in text


def test_an_explainers_run_reads_the_terms_already_explained_and_judgment_reads_the_whole_conversation(ws):
    first, second = ws
    _say("explainers", answer_comments.passages(first)[0], "The board is the run's message board.")
    _say("heads-up", answer_comments.passages(first)[0], "The 18 counts the deleted posts too.")
    cover = answer_comments.passages(second)
    text = checks.first_message(CORPUS, checks.read(CORPUS, "explainers"), checks.ANSWERS, cover)
    glossed = text.split("## Terms already explained", 1)[1].split("## Your task", 1)[0]
    assert "- The board is the run's message board." in glossed and "deleted posts" not in text
    assert "## Heads-ups already given" not in text
    judgment = checks.first_message(CORPUS, checks.read(CORPUS, "judgment"), checks.ANSWERS, cover)
    assert "## The conversation\n" in judgment and "OLD-TURN-RESULT" in judgment
    assert "## The conversation in brief" not in judgment and "## Terms already explained" not in judgment


def test_the_brief_shortens_the_oldest_turns_first_and_never_the_answer_checked(ws, monkeypatch):
    first, second = ws
    long = "x" * 5_000
    monkeypatch.setattr(context, "_entries", lambda path, forks=True: [
        context._Entry("[analyst]", f"question {i} {long}") if k == 0 else context._Entry("[session]", f"answer {i} {long}")
        for i in range(40) for k in (0, 1)] + [context._Entry("[analyst]", "last?"), context._Entry("[session]", SECOND)])
    text = context.render(CORPUS, "task", budget=100_000, parts=("brief",), answers=[second])
    assert SECOND in text and "### Turn 41 · the answer you check" in text and len(text) <= 100_000
    assert f"answer 39 {long}" in text and f"answer 30 {long}" not in text and "answer 0 xxx" in text
    text = context.render(CORPUS, "task", budget=20_000, parts=("brief",), answers=[second])
    assert SECOND in text and len(text) <= 20_000 and "oldest turns are left out" in text and "answer 0 " not in text
