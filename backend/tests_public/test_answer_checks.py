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

from app import answer_comments, checks, config, events, local, subagents, tools
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


def test_passages_split_paragraphs_list_items_and_sentences_with_their_offsets():
    ps = answer_comments.passages(_turn())
    texts = [p["text"] for p in ps]
    assert texts == [
        "The board holds 18 posts.",
        "Most came from agent-02, see [the log](events.jsonl#L4).",
        "The rest are\nstatus reports.",
        "Agent-01 posted 3 times.",
        "It used `grep -c x.y` once.",
        "Agent-03 posted [[2|board.jsonl#L7]] times?",
        "Yes.",
        "A numbered item, with e.g. a pause.",
        "Then more.",
        "A heading",
        "Done.",
    ]
    assert [p["ref"] for p in ps] == [f"answer:{TURN}#s{n}" for n in range(1, 12)]
    for p in ps[:-1]:
        assert p["row"] == TURN and ANSWER[p["start"]:p["end"]] == p["text"]
    assert ps[-1]["row"] == "u-second" and (ps[-1]["start"], ps[-1]["end"]) == (0, 5)
    assert len({p["fp"] for p in ps}) == len(ps)


def test_a_data_turn_is_one_that_read_searched_called_thimble_or_cites(board):
    plain = {"rows": [{"uuid": "u", "text": "Hello there."}], "tools": []}
    assert not answer_comments.is_data_turn(CORPUS, plain)
    for call in ({"name": "Read", "input": {"file_path": "events.jsonl"}},
                 {"name": "Bash", "input": {"command": "grep -c merged agents/agent-01.jsonl | head"}},
                 {"name": "Grep", "input": {"pattern": "x", "path": "agents"}},
                 {"name": "mcp__plugin_thimble_thimble__add_card", "input": {}}):
        assert answer_comments.is_data_turn(CORPUS, {**plain, "tools": [call]}), call
    assert not answer_comments.is_data_turn(CORPUS, {**plain, "tools": [{"name": "Read", "input": {"file_path": "/etc/hosts"}}]})
    assert not answer_comments.is_data_turn(CORPUS, {**plain, "tools": [{"name": "Bash", "input": {"command": "ls -la"}}]})
    assert answer_comments.is_data_turn(CORPUS, {"rows": [{"uuid": "u", "text": "See [[18|board.jsonl#L2]]."}]})
    assert answer_comments.is_data_turn(CORPUS, {"rows": [{"uuid": "u", "text": "See [it](card:abc123)."}]})
    assert not answer_comments.is_data_turn(CORPUS, {"rows": [{"uuid": "u", "text": "See [docs](https://x.org/a.md)."}]})


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


async def test_a_non_data_turn_and_checks_off_start_none(board, bridge, features):
    checks.answer_ended(CORPUS, _turn(text="Hello. How can I help?", tools_=[]))
    await asyncio.sleep(0.05)
    assert bridge.ops("spawn") == [] and not _run()
    assert answer_comments.answers(CORPUS) == [], "an answer that is no data answer is not kept"
    features.add("checks")
    checks.answer_ended(CORPUS, _turn())
    checks.main_turn_ended(CORPUS, "2000-01-01T00:00:00+00:00")
    await asyncio.sleep(0.05)
    assert bridge.ops("spawn") == [] and not _run()


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


async def test_an_answer_run_s_end_tells_main_nothing(board, bridge, features, monkeypatch):
    posted: list = []
    monkeypatch.setattr(events, "post", lambda *a, **k: posted.append((a, k)))
    act = await _answered()
    act.notify = True  # even a run that was asked to tell: a run over answers never does
    await _comment(act, f"answer:{TURN}#s1", "The board holds 20 posts.", "toolu_b1")
    subagents.run_ended(CORPUS, act.agent, "done", "One comment.", source="handback")
    await _until(lambda: _run().get("status") == "done", "the run never ended")
    assert posted == [], "no event for main"
    assert {op for op, _ in bridge.calls} <= {"spawn", "push_roles"}, "no message to main or to an agent"
    assert len(answer_comments.open_comments(CORPUS)) == 1
    # a second answer covers its own sentences only
    second = _turn(text="Agent-02 merged 6 PRs.", turn="u-next")
    checks.answer_ended(CORPUS, second)
    await _until(lambda: _run().get("status") == "running", "no second run")
    assert _run()["covered"] == ["answer:u-next#s1", "answer:u-next#s2"]


async def test_dismiss_reopen_state_and_routes(board, bridge, features):
    act = await _answered()
    await _comment(act, f"answer:{TURN}#s3", "The rest are not all status reports.", "toolu_c1")
    got = await local.state(CORPUS, "answer-comments", [])
    [cm] = got["comments"]
    assert set(cm) == {"id", "check", "check_name", "color", "about", "turn", "row", "ref", "start", "end", "quote",
                       "text", "details", "status", "at"}
    assert (cm["check_name"], cm["about"], cm["status"]) == ("Important details",
                                                              "it looks for what a reader would likely miss", "open")
    assert (await local.state(CORPUS, "answer-comments", ["--session", "sid-1"]))["comments"] == [cm]
    assert (await local.state(CORPUS, "answer-comments", ["--session", "other"]))["comments"] == []
    done = await local.act(CORPUS, "answer-comment-resolve", {"comment": cm["id"]})
    assert done == {"ok": True, "comment": cm["id"], "status": "dismissed"}
    assert (await local.state(CORPUS, "answer-comments", []))["comments"] == []
    assert (await local.state(CORPUS, "answer-comments", ["--status", "all"]))["comments"][0]["status"] == "dismissed"
    again = await local.act(CORPUS, "answer-comment-resolve", {"comment": cm["id"], "reopen": True})
    assert again["status"] == "open"
    with pytest.raises(local.StateError):
        await local.act(CORPUS, "answer-comment-resolve", {"comment": "nope"})
    # the routes on checks.router
    listed = await checks.answer_comments_route(CORPUS)
    assert [x["id"] for x in listed["comments"]] == [cm["id"]] and listed["running"]
    assert (await checks.answer_comment_dismiss_route(CORPUS, cm["id"]))["status"] == "dismissed"
    assert (await checks.answer_comment_reopen_route(CORPUS, cm["id"]))["status"] == "open"
    paths = {r.path for r in checks.router.routes}
    assert {"/ws/{c}/answer-comments", "/ws/{c}/answer-comments/{cid}/dismiss",
            "/ws/{c}/answer-comments/{cid}/reopen"} <= paths


def test_a_comment_s_color_is_its_check_s_colour_for_each_built_in(board):
    turn = _turn()
    answer_comments.store_answer(CORPUS, turn)
    ps = answer_comments.passages(turn)
    for i, cid in enumerate(checks.BUILTINS):
        answer_comments.add(CORPUS, passage=ps[i], text=f"From {cid}.", author="check", check=cid, run="r")
    got = {cm["check"]: cm["color"] for cm in answer_comments.state(CORPUS)["comments"]}
    want = {cid: checks.read(CORPUS, cid)["colour"] for cid in checks.BUILTINS}
    assert got == want == {"judgment": 1, "important-details": 2, "unverified": 5}
    assert all(c in checks.COLOURS for c in got.values())


def test_the_built_ins_cover_answers_and_run_check_does_not_run_on_them(board):
    for cid in checks.BUILTINS:
        assert checks.covers(checks.read(CORPUS, cid), "answers")
        assert checks.read(CORPUS, cid)["about"].startswith("it looks for ")
    assert checks.RUN_ON == ("documents", "cards") and "answers" in checks.COVERS
    assert checks.targets_of(CORPUS, checks.read(CORPUS, IMPORTANT)) == [checks.CANVAS], "no document written yet"
