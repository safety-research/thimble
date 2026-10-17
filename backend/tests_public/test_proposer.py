"""proposer.py: the view proposer. A turn of main that answered the analyst, a side thread's answer and an orientation's
end each run one fork of main (a subagent of the analyst's Claude Code session, agent_call.structured with `fork`), which
may show a view proposal card (views.offer); every failure leaves a notice with its fix in the foreground (notices.py).
The fork is faked (proposer._fork) with the CallResult agent_call gives and, for the model that replied, the fork's
transcript; the view proposal storage (views.offer, open_offer, propose_enabled) is faked where a test needs it.

session.py's part is here too: which turns answered the analyst, the cut a turn ended at, main's context size, and the
notices for a reply Claude's safeguards switched to another model."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from app import agent_call, agents, config, notices, proposer, session, views
from app.call_result import CallResult
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
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
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


def result(output: dict | None = None, *, status: str = "ok", detail: str = "", agent: str = "afork0001",
           model: str = "claude-opus-5-5") -> CallResult:
    """What agent_call.structured gives for the fork: its answer, or its status and why."""
    return CallResult(status=status, output=output if status == "ok" else None, model_requested=model,
                      model_used=model if status == "ok" else None, duration_s=1.0, session_id=agent, detail=detail)


@pytest.fixture()
def forks(monkeypatch) -> list[dict]:
    """The fork faked: each call is recorded (prompt, main's session and model) and answers with `forks.answer` (a
    CallResult); `forks.replied` is the model of the fork's reply its transcript holds (none: no transcript)."""
    class Forks(list):
        answer: Any = result(ANSWER)
        replied: str | None = None

    got = Forks()

    async def fake(c, lv, prompt):
        got.append({"prompt": prompt, "sid": lv.sid, "model": lv.model, "cut": lv.last_cut})
        a = got.answer
        if got.replied and (path := proposer.fork_transcript(lv, a.session_id)) is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(_assistant(_say(json.dumps(ANSWER)), model=got.replied)) + "\n")
        return a

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
    assert run["after"] == ["main"] and run["cut"] == "cut-1" and run["agent"] == "afork0001"
    assert proposer.pending(CORPUS) is None
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
    (result(status="no_session", detail=agent_call.NO_SESSION), "no_session", agent_call.NO_SESSION),
])
async def test_any_other_failure_says_why_with_try_again(cwd, tmp_path, cards, forks, answer, status, reason):
    forks.answer = answer
    await _one_turn(cwd, tmp_path)
    assert cards == [] and _runs()[0]["status"] == status
    n = _shown_notice()
    assert n["text"] == f"Couldn't check for a view proposal: {reason}."
    assert n["action"] == {"label": "Try again", "do": "proposals-retry"}


async def test_a_card_from_a_fallback_model_shows_with_a_notice_and_a_run_that_works_clears_it(cwd, tmp_path, cards,
                                                                                            forks):
    forks.replied = "claude-opus-4-8"
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    await _settle()
    assert [r["name"] for r in cards] == ["Reply Network"] and _runs()[0]["fallback"] == "claude-opus-4-8"
    assert _shown_notice()["text"] == "This view proposal came from Opus 4.8: Claude's safeguards switched models."
    cards.clear()
    forks.replied = None
    forks.answer = result({"show": False, "why": "Nothing new.", "proposal": None})
    _append(p, lv, _turn("And now?", "cut-2"))
    await _settle()
    assert _shown_notice() is None and _runs()[-1]["show"] is False


# ----------------------------------------------------------------------------- the fork


def _lv(**kw: Any) -> session.Live:
    lv = session.Live(CORPUS, SID, "/corpus", "/t.jsonl", None)
    for k, v in kw.items():
        setattr(lv, k, v)
    return lv


async def test_the_fork_is_a_model_call_of_agent_call_that_forks_main(monkeypatch):
    got: dict = {}

    async def structured(c, prompt, **kw):
        got.update(c=c, prompt=prompt, **kw)
        return result(ANSWER)

    monkeypatch.setattr(agent_call, "structured", structured)
    res = await proposer._fork(CORPUS, _lv(model="claude-opus-5-5", effort="high"), "THE PROMPT")
    assert res.output == ANSWER and got["prompt"] == "THE PROMPT" and got["fork"] is True
    assert got["title"] == "thimble: view proposal" and got["done"] == "thimble checked for a view proposal"
    assert got["model"] == "claude-opus-5-5" and got["timeout_s"] == proposer.FORK_TIMEOUT_S
    assert got["tool"].input_schema["required"] == ["show", "why", "proposal"]


def test_the_answer_s_schema_takes_a_proposal_or_none_and_parse_reads_what_fits():
    for ok in (ANSWER, {"show": False, "why": "Nothing new.", "proposal": None},
               {**ANSWER, "proposal": {**ANSWER["proposal"], "claims": "board.jsonl"}}):
        assert agent_call._invalid(proposer.SCHEMA, ok) == "" and proposer.parse(json.dumps(ok))[0] is not None
    for bad in ({"show": True, "why": "x", "proposal": None}, {"show": "yes", "why": "", "proposal": None},
                {**ANSWER, "proposal": {**ANSWER["proposal"], "claims": []}}):
        assert agent_call._invalid(proposer.SCHEMA, bad), bad


def test_the_threads_part_takes_the_room_main_s_context_leaves():
    assert proposer._threads_budget(_lv(context_tokens=10_000), 20_000) == proposer.CONTEXT_CHARS
    tight = proposer._threads_budget(_lv(context_tokens=150_000), 20_000)
    assert tight == (200_000 - 150_000 - proposer.RESERVE_TOKENS) * 4 - 20_000
    assert proposer._threads_budget(_lv(context_tokens=175_000), 20_000) == proposer.MIN_CONTEXT_CHARS
    assert proposer._threads_budget(_lv(context_tokens=185_000), 20_000) == proposer.CONTEXT_CHARS, "the 1M window"
    assert proposer._threads_budget(_lv(context_tokens=990_000), 20_000) == proposer.MIN_CONTEXT_CHARS


def test_the_fork_s_transcript_is_beside_main_s(tmp_path):
    lv = _lv(transcript_path=str(tmp_path / f"{SID}.jsonl"))
    assert proposer.fork_transcript(lv, "a1b2") == tmp_path / SID / "subagents" / "agent-a1b2.jsonl"
    assert proposer.fork_transcript(lv, "../x") is None and proposer.fork_transcript(lv, None) is None
