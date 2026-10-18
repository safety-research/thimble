"""proposer.py: the view proposer. A turn of main that answered the analyst, a side thread's answer and an orientation's
end each run one model call over a fork of main's conversation (model_call.fork, the module's $.model.fork), which may
show a view proposal card (views.offer); every failure leaves a notice with its fix in the foreground (notices.py). The
fork is faked (proposer._fork) with the CallResult model_call gives; the view proposal storage (views.offer,
open_offer, propose_enabled) is faked where a test needs it.

session.py's part is here too: which turns answered the analyst, the cut a turn ended at, main's context size, and the
notices for a reply Claude's safeguards switched to another model."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from app import agents, config, model_call, notices, proposer, session, views
from app.call_result import NO_SESSION, CallResult, schema_errors
from target_blocks import target_blocks  # noqa: F401 — the core lane's target flags, where prompts.py lacks them

CORPUS = "mini"
SID = "a0b0c0d0-0000-4000-8000-0000000000a1"
END = {"type": "system", "subtype": "turn_duration"}
PROPOSE_ENABLED = views.propose_enabled  # the real switch (PROPOSE_ENV, then thimble's config), which `cards` fakes
ANSWER = {"show": True, "why": "The analyst keeps comparing who replies to whom.",
          "proposal": {"name": "Reply Network", "description": "Who replies to whom, as a network.",
                       "task": "Compare how the agents coordinate.", "claims": ["board.jsonl"]}}


# ----------------------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    from app import subagents

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    # thimble is on in main's session: no module of an earlier test's session holds a run back (module_back)
    monkeypatch.setattr(subagents, "module_away", lambda c: False)
    session._live.clear()
    proposer._tasks.clear()
    proposer._running.clear()
    yield
    for t in proposer._tasks.values():
        t.cancel()
    proposer._tasks.clear()
    session._live.clear()


@pytest.fixture()
def cards(monkeypatch) -> list[dict]:
    """View proposals on, with the storage faked: views.offer appends a row here, open_offer gives the one that
    waits."""
    rows: list[dict] = []
    monkeypatch.setenv(proposer.PROPOSE_ENV, "on")
    monkeypatch.setattr(views, "propose_enabled", lambda c: True)
    monkeypatch.setattr(views, "build_problem_for", lambda c: "")
    monkeypatch.setattr(views, "open_offer", lambda c: next((r for r in rows if r["status"] == "suggested"), None))

    def offer(c, *, name, description, task, claims, after, why, proposed_by="proposer", arrangement=""):
        row = {"slug": name.lower().replace(" ", "-"), "name": name, "description": description, "task": task,
               "claims": claims, "status": "suggested", "offered": {"after": after, "why": why}}
        rows.append(row)
        return row, ""

    monkeypatch.setattr(views, "offer", offer)
    monkeypatch.setattr(proposer, "DEBOUNCE_MAIN_S", 0.0)
    monkeypatch.setattr(proposer, "DEBOUNCE_OTHER_S", 0.0)
    return rows


def result(output: dict | None = None, *, status: str = "ok", detail: str = "", model: str = "claude-opus-5-5",
           usage: dict | None = None) -> CallResult:
    """What model_call.fork gives: its answer, or its status and why."""
    return CallResult(status=status, output=output if status == "ok" else None, model_requested=model,
                      model_used=model if status == "ok" else None, duration_s=1.0, detail=detail, usage=usage)


@pytest.fixture()
def forks(monkeypatch) -> list[dict]:
    """The fork faked: each call is recorded (prompt, main's session and model) and answers with `forks.answer` (a
    CallResult)."""
    class Forks(list):
        answer: Any = result(ANSWER, usage={"input_tokens": 400, "cache_read_input_tokens": 23_000})

    got = Forks()

    async def fake(c, lv, prompt):
        got.append({"prompt": prompt, "sid": lv.sid, "model": lv.model, "cut": lv.last_cut})
        return got.answer

    monkeypatch.setattr(proposer, "_fork", fake)
    return got


@pytest.fixture()
def cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def _log(chat: str = agents.MAIN_ID) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def _shown_notice(key: str = proposer.NOTICE_KEY) -> dict | None:
    """The open notice under `key` (notices.open_notices), the one the foreground shows."""
    return next((n for n in notices.open_notices(CORPUS) if n.get("key") == key), None)


def _runs() -> list[dict]:
    p = views.state_dir(CORPUS) / proposer.LOG_FILE
    return [json.loads(x) for x in p.read_text().splitlines()] if p.is_file() else []


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _assistant(*blocks: dict, model: str = "claude-opus-5-5", **extra: Any) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": model, "content": list(blocks)}, **extra}


def _say(text: str) -> dict:
    return {"type": "text", "text": text}


def _end(uuid: str) -> dict:
    return {**END, "uuid": uuid}


def _attach(cwd: str, tmp_path: Path) -> tuple[session.Live, Path]:
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, cwd, str(p))
    assert lv is not None
    session.tail_once(lv)
    return lv, p


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


async def _settle() -> None:
    for _ in range(50):
        tasks = [t for t in proposer._tasks.values() if not t.done()]
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)


def _turn(text: str, cut: str) -> list[dict]:
    return [_human(text), _assistant(_say(f"About: {text}")), _end(cut)]


# ----------------------------------------------------------------------------- triggers


async def test_an_analyst_s_turn_end_runs_one_fork_of_main_and_shows_the_card(cwd, tmp_path, cards, forks):
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies to whom on the board?", "cut-1"))
    await _settle()
    assert [(f["cut"], f["sid"], f["model"]) for f in forks] == [("cut-1", SID, "claude-opus-5-5")]
    assert forks[0]["prompt"].startswith("# View proposals") and "## Now" in forks[0]["prompt"]
    assert [r["name"] for r in cards] == ["Reply Network"] and cards[0]["offered"]["after"] == "main"
    (run,) = _runs()
    assert run["status"] == "ok" and run["offered"] == "reply-network" and run["show"] is True
    assert run["after"] == ["main"] and run["cut"] == "cut-1"
    assert run["input_tokens"] == 23_400 and run["cached"] == 23_000, "what the fork read, mostly from the cache"
    assert proposer.pending(CORPUS) is None
    assert _shown_notice() is None


async def test_k8_a_turn_end_while_thimble_is_off_waits_with_no_notice_and_runs_once_it_is_on(cwd, tmp_path, cards,
                                                                                               forks, monkeypatch):
    """Bug hunt round 10, K8: with thimble off in main's session (/plugin, which is no end of the session), a turn's end
    left "Couldn't check for a view proposal: Your Claude Code session's thimble module did not answer; it stopped
    polling" with Try again, beside the page's line that thimble is off. The run waits, tells nothing, and runs once
    thimble is on again."""
    from app import subagents

    off = {"now": True}
    monkeypatch.setattr(subagents, "module_away", lambda c: off["now"])
    monkeypatch.setattr(subagents, "MODULE_BACK_POLL_S", 0.01)
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies to whom on the board?", "cut-1"))
    for _ in range(50):  # as long as a run takes to fork when thimble is on
        await asyncio.sleep(0.01)
    assert forks == [] and _shown_notice() is None and _runs() == []
    off["now"] = False  # /plugin on again
    await _settle()
    assert [f["cut"] for f in forks] == ["cut-1"] and [r["name"] for r in cards] == ["Reply Network"]
    assert _shown_notice() is None


# ----------------------------------------------------------------------------- the gate


async def test_view_proposals_off_keep_no_job(cwd, tmp_path, cards, forks, monkeypatch):
    lv, p = _attach(cwd, tmp_path)
    monkeypatch.setattr(views, "propose_enabled", lambda c: False)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    monkeypatch.setenv(proposer.PROPOSE_ENV, "off")
    monkeypatch.setattr(views, "propose_enabled", PROPOSE_ENABLED)
    _append(p, lv, _turn("And now?", "cut-2"))
    await _settle()
    assert forks == [] and proposer.pending(CORPUS) is None


# ----------------------------------------------------------------------------- outcomes and notices


async def _one_turn(cwd, tmp_path, cut: str = "cut-1") -> None:
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies?", cut))
    await _settle()


async def test_main_in_plan_mode_starts_no_fork(cwd, tmp_path, cards, forks, monkeypatch):
    monkeypatch.setattr(session, "main_mode", lambda c: "plan")
    await _one_turn(cwd, tmp_path)
    assert forks == [] and cards == [] and _runs() == [] and _shown_notice() is None


async def test_a_request_the_safeguards_blocked_says_so_with_try_again_and_turn_off(cwd, tmp_path, cards, forks):
    forks.answer = result(status="refused",
                          detail="API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com"
                                 "/legal/aup). Claude Code can't respond to this message with Opus 5.5.")
    await _one_turn(cwd, tmp_path)
    assert cards == [] and _runs()[0]["status"] == "refused"
    n = _shown_notice()
    assert n["text"] == "Couldn't check for a view proposal: Claude's safeguards blocked the request."
    assert n["action"] == [{"label": "Try again", "do": "proposals-retry"},
                           {"label": "Turn off view proposals", "do": "proposals-off"}]
    assert n["kind"] == "proposals" and n["agent"] == "View proposals" and n["chat"] is None
    assert [r for r in _log() if r["type"] == notices.TYPE] == [], "the proposer has no chat: no row in main's"


@pytest.mark.parametrize("answer,status,reason", [
    (result(status="timeout", detail="the call ran past 300 s"), "timeout", "Claude didn't answer within 5 minutes"),
    (result(status="error", detail="API Error: Repeated 529 Overloaded errors"), "error",
     "API Error: Repeated 529 Overloaded errors"),
    (result(status="no_tool_call", detail="the fork's answer did not fit ($: 'show' is a required property)"),
     "unparsed", "Claude's answer couldn't be read"),
    (result(status="no_session", detail=NO_SESSION), "no_session", NO_SESSION),
])
async def test_any_other_failure_says_why_with_try_again(cwd, tmp_path, cards, forks, answer, status, reason):
    forks.answer = answer
    await _one_turn(cwd, tmp_path)
    assert cards == [] and _runs()[0]["status"] == status
    n = _shown_notice()
    assert n["text"] == f"Couldn't check for a view proposal: {reason}."
    assert n["action"] == {"label": "Try again", "do": "proposals-retry"}


async def test_a_run_with_nothing_to_fork_tells_nothing_and_a_run_that_works_clears_a_notice(cwd, tmp_path, cards,
                                                                                            forks):
    forks.answer = result(status="error", detail="API Error: 500 (server_error)")
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    await _settle()
    assert _shown_notice()["text"] == "Couldn't check for a view proposal: API Error: 500 (server_error)."
    forks.answer = result(status="stopped", detail=model_call.NOTHING_TO_FORK)
    _append(p, lv, _turn("And now?", "cut-2"))
    await _settle()
    assert _runs()[-1]["status"] == "stopped" and _shown_notice() is not None, "nothing to fork changes nothing"
    forks.answer = result({"show": False, "why": "Nothing new.", "proposal": None})
    _append(p, lv, _turn("And then?", "cut-3"))
    await _settle()
    assert _shown_notice() is None and _runs()[-1]["show"] is False


# ----------------------------------------------------------------------------- the fork


def _lv(**kw: Any) -> session.Live:
    lv = session.Live(CORPUS, SID, "/corpus", "/t.jsonl", None)
    for k, v in kw.items():
        setattr(lv, k, v)
    return lv


async def test_the_fork_is_a_model_call_over_main_s_conversation(monkeypatch):
    got: dict = {}

    async def fork(c, prompt, **kw):
        got.update(c=c, prompt=prompt, **kw)
        return result(ANSWER)

    monkeypatch.setattr(model_call, "fork", fork)
    res = await proposer._fork(CORPUS, _lv(model="claude-opus-5-5", effort="high"), "THE PROMPT")
    assert res.output == ANSWER and got["prompt"] == "THE PROMPT"
    assert got["model"] == "claude-opus-5-5" and got["timeout_s"] == proposer.FORK_TIMEOUT_S
    assert got["tool"].input_schema["required"] == ["show", "why", "proposal"]


def test_the_answer_s_schema_takes_a_proposal_or_none_and_parse_reads_what_fits():
    for ok in (ANSWER, {"show": False, "why": "Nothing new.", "proposal": None},
               {**ANSWER, "proposal": {**ANSWER["proposal"], "claims": "board.jsonl"}}):
        assert schema_errors(proposer.SCHEMA, ok) == "" and proposer.parse(json.dumps(ok))[0] is not None
    for bad in ({"show": True, "why": "x", "proposal": None}, {"show": "yes", "why": "", "proposal": None},
                {**ANSWER, "proposal": {**ANSWER["proposal"], "claims": []}}):
        assert schema_errors(proposer.SCHEMA, bad), bad


def test_the_threads_part_takes_the_room_main_s_context_leaves():
    assert proposer._threads_budget(_lv(context_tokens=10_000), 20_000) == proposer.CONTEXT_CHARS
    tight = proposer._threads_budget(_lv(context_tokens=150_000), 20_000)
    assert tight == (200_000 - 150_000 - proposer.RESERVE_TOKENS) * 4 - 20_000
    assert proposer._threads_budget(_lv(context_tokens=175_000), 20_000) == proposer.MIN_CONTEXT_CHARS
    assert proposer._threads_budget(_lv(context_tokens=185_000), 20_000) == proposer.CONTEXT_CHARS, "the 1M window"
    assert proposer._threads_budget(_lv(context_tokens=990_000), 20_000) == proposer.MIN_CONTEXT_CHARS
