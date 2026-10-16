"""proposer.py: the view proposer. A turn of main that answered the analyst, a side thread's answer and an orientation's
end each run one fork of main's session, which may show a view proposal card (views.offer); every failure leaves a
notice with its fix in the foreground (notices.py). The fork is faked (proposer._fork) with the stream-json Claude Code
prints; the view proposal storage (views.offer, open_offer, propose_enabled) is faked where a test needs it.

session.py's part is here too: which turns answered the analyst, the cut a turn ended at, main's context size, and the
notices for a reply Claude's safeguards switched to another model."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from app import agents, config, notices, orientation, proposer, session, views

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


def stream(text: str | None = None, *, model: str = "claude-opus-5-5", cost: float = 2.5, error: str | None = None,
           error_text: str = "", stop: str = "end_turn", is_error: bool = False, extra: list | None = None) -> str:
    """Claude Code's stream-json output of one `claude -p` call: init, the replies, the result."""
    evs: list[dict] = [{"type": "system", "subtype": "init", "model": model, "tools": [], "mcp_servers": []},
                       *(extra or [])]
    if error is not None:
        evs.append({"type": "assistant", "is_api_error_message": True, "error": error,
                    "message": {"model": "<synthetic>", "stop_reason": stop,
                                "content": [{"type": "text", "text": error_text}]}})
        evs.append({"type": "result", "subtype": "success", "is_error": True, "result": error_text,
                    "total_cost_usd": cost})
    else:
        evs.append({"type": "assistant", "message": {"model": model, "stop_reason": stop,
                                                     "content": [{"type": "text", "text": text or ""}]}})
        evs.append({"type": "result", "subtype": "success", "is_error": is_error, "result": text or "",
                    "total_cost_usd": cost})
    return "\n".join(json.dumps(e) for e in evs) + "\n"


@pytest.fixture()
def forks(monkeypatch) -> list[dict]:
    """The fork faked: each call is recorded (cut, prompt, model) and answers with `forks.answer` (a stream, or a dict
    of _fork's result)."""
    class Forks(list):
        answer: Any = stream("```json\n" + json.dumps(ANSWER) + "\n```")

    got = Forks()

    async def fake(lv, cut, prompt, model_id, effort, speed):
        got.append({"cut": cut, "prompt": prompt, "model": model_id, "effort": effort, "sid": lv.sid})
        a = got.answer
        return a if isinstance(a, dict) else {"code": 0, "stdout": a, "stderr": "", "timed_out": False, "seconds": 1.0}

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


async def test_an_analyst_s_turn_end_runs_one_fork_at_its_cut_and_shows_the_card(cwd, tmp_path, cards, forks):
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies to whom on the board?", "cut-1"))
    await _settle()
    assert [(f["cut"], f["sid"]) for f in forks] == [("cut-1", SID)]
    assert [r["name"] for r in cards] == ["Reply Network"] and cards[0]["offered"]["after"] == "main"
    (run,) = _runs()
    assert run["status"] == "ok" and run["offered"] == "reply-network" and run["show"] is True
    assert run["cost_usd"] == 2.5 and run["after"] == ["main"] and run["cut"] == "cut-1"
    assert proposer.pending(CORPUS) is None
    assert _shown_notice() is None


async def test_turns_that_did_not_answer_the_analyst_run_nothing(cwd, tmp_path, cards, forks):
    """A task notification's turn, a Monitor's re-arm and a start_agent event's turn are no analyst's turn."""
    lv, p = _attach(cwd, tmp_path)
    note = ("<task-notification>\n<task-id>x1</task-id>\n<status>completed</status>\n<result>done</result>\n"
            "</task-notification>")
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("The agent is done.")), _end("cut-n")])
    event = '<thimble-event kind="start_agent" event="ev1">Start the writer.</thimble-event>'
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": event}},
                    _assistant(_say("Starting it.")), _end("cut-s")])
    await _settle()
    assert forks == [] and proposer.pending(CORPUS) is None


async def test_the_analyst_s_browser_message_is_their_turn(cwd, tmp_path, cards, forks):
    lv, p = _attach(cwd, tmp_path)
    event = '<thimble-event kind="main" event="ev2">Compare the agents.</thimble-event>'
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": event}},
                    _assistant(_say("Here they are.")), _end("cut-b")])
    await _settle()
    assert [f["cut"] for f in forks] == ["cut-b"]


async def test_a_side_thread_question_runs_one_fork_after_the_thread_answers(cwd, tmp_path, cards, forks):
    """main's turn that hands a side thread's question to the thread's fork is no analyst's turn of main: the
    proposer runs once, after the thread answers (session._finish_sub), at main's cut."""
    lv, p = _attach(cwd, tmp_path)
    tid = agents.new_thread(CORPUS, None, None, "Replies")["id"]
    agents.Recorder(CORPUS, tid).record("user", text="Which agent replies most?")
    event = f'<thimble-event kind="thread" thread="{tid}" event="ev4">Which agent replies most?</thimble-event>'
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": event}},
                    _assistant(_say("I asked the thread's fork.")), _end("cut-r")])
    await _settle()
    assert forks == [] and proposer.pending(CORPUS) is None, "main's relay turn runs nothing"
    session._proposer_after_thread(lv, tid)  # the thread's fork answered
    await _settle()
    (f,) = forks
    assert f["cut"] == "cut-r" and cards[0]["offered"]["after"] == f"thread:{tid}"


async def test_a_side_thread_question_main_answers_itself_runs_one_fork_after_main_s_turn(cwd, tmp_path, cards, forks):
    """Main may answer a side thread's question itself with reply_in_thread, so no fork's end runs the proposer (live
    check: it then ran 0 times). Main's own reply, by the caller hook's line with no agent, runs it once, after main's
    turn ends, at that turn's cut. A fork's reply_in_thread runs nothing itself, since the fork's end does."""
    from app import subagent_files, threads, tools

    lv, p = _attach(cwd, tmp_path)
    tid = agents.new_thread(CORPUS, None, None, "Replies")["id"]
    agents.Recorder(CORPUS, tid).record("user", text="Which agent replies most?")
    event = f'<thimble-event kind="thread" thread="{tid}" event="ev5">Which agent replies most?</thimble-event>'
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": event}}])
    ws = config.workspace_dir(CORPUS)
    subagent_files.add_caller(ws, "toolu_fork1", "a0fork", "fork")
    await threads.tool_reply_in_thread(tools.Ctx(CORPUS, tools.ANALYST, tool_use_id="toolu_fork1"),
                                       {"thread": tid, "text": "Agent B, from the fork."})
    await _settle()
    assert proposer.pending(CORPUS) is None, "a fork's reply: its end runs the proposer"
    subagent_files.add_caller(ws, "toolu_main1", "", "")
    await threads.tool_reply_in_thread(tools.Ctx(CORPUS, tools.ANALYST, tool_use_id="toolu_main1"),
                                       {"thread": tid, "text": "Agent B replies most."})
    await _settle()
    assert forks == [] and proposer.pending(CORPUS)["after"] == [f"thread:{tid}"], "it waits for main's turn to end"
    _append(p, lv, [_assistant(_say("I answered in the thread.")), _end("cut-t")])
    await _settle()
    (f,) = forks
    assert f["cut"] == "cut-t" and cards[0]["offered"]["after"] == f"thread:{tid}"


async def test_a_side_thread_question_typed_with_thimble_ask_runs_one_fork_after_the_thread_answers(cwd, tmp_path,
                                                                                                  cards, forks):
    """/thimble:ask in main's terminal sends a side thread's question as the thread's composer in the browser does:
    main's turn that hands it to the thread's fork is no analyst's turn of main either, so the proposer runs once,
    after the thread answers, also when that run shows no card. A line the analyst types to main still is their turn."""
    forks.answer = stream("```json\n" + json.dumps({"show": False, "why": "Nothing new to show."}) + "\n```")
    lv, p = _attach(cwd, tmp_path)
    tid = agents.new_thread(CORPUS, None, None, "Replies")["id"]
    agents.Recorder(CORPUS, tid).record("user", text="Which agent replies most?")
    ask = ("<command-message>thimble:ask</command-message>\n<command-name>/thimble:ask</command-name>\n"
           "<command-args>Replies Which agent replies most?</command-args>")
    _append(p, lv, [_human(ask), _assistant(_say("I asked the thread's fork.")), _end("cut-a")])
    await _settle()
    assert forks == [] and proposer.pending(CORPUS) is None, "main's relay turn runs nothing"
    session._proposer_after_thread(lv, tid)  # the thread's fork answered
    await _settle()
    assert [f["cut"] for f in forks] == ["cut-a"]
    _append(p, lv, _turn("Who replies to whom on the board?", "cut-m"))
    await _settle()
    assert [f["cut"] for f in forks] == ["cut-a", "cut-m"]


async def test_a_thread_and_an_orientation_wait_for_main_and_run_once_with_both_sentences(cwd, tmp_path, cards,
                                                                                       forks):
    """A side thread's answer and an orientation's end that come while main works on something else (here a
    start_agent event) run once, after that turn, at its cut, and the prompt says both happened."""
    lv, p = _attach(cwd, tmp_path)
    tid = agents.new_thread(CORPUS, None, None, "Replies")["id"]
    agents.Recorder(CORPUS, tid).record("user", text="Which agent replies most?")
    note = '<thimble-event kind="start_agent" event="ev3">Start it.</thimble-event>'
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("Starting it."))])
    assert lv.turn_open and not lv.turn_analyst
    proposer.trigger(CORPUS, f"thread:{tid}")
    proposer.trigger(CORPUS, "orientation")
    await _settle()
    assert forks == [] and proposer.pending(CORPUS)["after"] == [f"thread:{tid}", "orientation"]
    _append(p, lv, [_end("cut-1")])
    await _settle()
    (f,) = forks
    assert f["cut"] == "cut-1", "no cut of an analyst's turn in the job: main's last"
    now = f["prompt"].split("## Now", 1)[1]
    assert "The orientation has just finished." in now
    assert 'A side thread has just answered the analyst: "Which agent replies most?"' in now
    assert cards[0]["offered"]["after"] == "orientation"


async def test_a_pending_job_survives_the_process_and_runs_at_the_next_turn_end(cwd, tmp_path, cards, forks):
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    for t in proposer._tasks.values():  # the server stops before the debounce ends
        t.cancel()
    await asyncio.sleep(0)
    proposer._tasks.clear()
    assert proposer.pending(CORPUS)["cut"] == "cut-1"
    assert forks == []
    proposer.turn_ended(CORPUS, sid=SID, analyst=False, cut="cut-x")  # any turn end of a later process
    await _settle()
    assert [f["cut"] for f in forks] == ["cut-1"]


def test_without_a_running_loop_a_trigger_keeps_the_job_and_starts_nothing(cards):
    proposer.trigger(CORPUS, "main", cut="c1", sid=SID)
    proposer.trigger(CORPUS, "thread:t1")
    assert proposer.pending(CORPUS)["after"] == ["main", "thread:t1"] and proposer._tasks == {}
    state = json.loads((views.state_dir(CORPUS) / "proposer.json").read_text())
    assert state["job"]["cut"] == "c1", "the job is views' proposer.json `job` (proposer_state)"


# ----------------------------------------------------------------------------- the gate


async def test_no_fork_while_a_card_waits_or_views_cannot_be_built(cwd, tmp_path, cards, forks, monkeypatch):
    lv, p = _attach(cwd, tmp_path)
    cards.append({"slug": "board", "name": "Board", "status": "suggested", "offered": {}})
    _append(p, lv, _turn("Who replies?", "cut-1"))
    await _settle()
    assert forks == []
    cards.clear()
    monkeypatch.setattr(views, "build_problem_for", lambda c: "Custom views need Node 20+.")
    _append(p, lv, _turn("And now?", "cut-2"))
    await _settle()
    assert forks == []


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


async def test_a_request_the_safeguards_blocked_says_so_with_try_again_and_turn_off(cwd, tmp_path, cards, forks):
    forks.answer = stream(error="invalid_request", stop="refusal",
                          error_text="API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com"
                                     "/legal/aup). Claude Code can't respond to this message with Opus 5.5.")
    await _one_turn(cwd, tmp_path)
    assert cards == [] and _runs()[0]["status"] == "refused"
    n = _shown_notice()
    assert n["text"] == "Couldn't check for a view proposal: Claude's safeguards blocked the request."
    assert n["action"] == [{"label": "Try again", "do": "proposals-retry"},
                           {"label": "Turn off view proposals", "do": "proposals-off"}]
    assert n["kind"] == "proposals" and n["agent"] == "View proposals" and n["chat"] is None
    assert [r for r in _log() if r["type"] == notices.TYPE] == [], "the proposer has no chat: no row in main's"


async def test_no_sign_in_says_how_to_sign_in(cwd, tmp_path, cards, forks):
    forks.answer = stream(error="authentication_failed", stop="stop_sequence",
                          error_text="Not logged in · Please run /login")
    await _one_turn(cwd, tmp_path)
    assert _runs()[0]["status"] == "auth"
    n = _shown_notice()
    # as short as main's own sign-in card, whose fix runs in the terminal; Try again stays here
    assert n["text"] == ("Couldn't check for a view proposal: Claude Code isn't signed in. In your terminal: run /login "
                         "(or `claude auth login` in a shell).")
    assert n["action"] == {"label": "Try again", "do": "proposals-retry"}


@pytest.mark.parametrize("error_text", ["API Error: 403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\"}}",
                                        "Please run /login · API Error: 403 Forbidden"])
async def test_access_refused_has_its_own_words_not_the_sign_in_s(cwd, tmp_path, cards, forks, error_text):
    forks.answer = stream(error="unknown", stop="stop_sequence", error_text=error_text)
    await _one_turn(cwd, tmp_path)
    assert _runs()[0]["status"] == "forbidden"
    n = _shown_notice()
    assert n["text"] == ("Couldn't check for a view proposal: access was refused for this account or organization "
                         "(403). In your terminal: run /login to check the account, or check your organization's "
                         "settings.")
    assert "isn't signed in" not in n["text"]
    assert n["action"] == {"label": "Try again", "do": "proposals-retry"}


@pytest.mark.parametrize("answer,status,reason", [
    ({"code": None, "stdout": "", "stderr": "", "timed_out": True, "seconds": 300.0}, "timeout",
     "Claude didn't answer within 5 minutes"),
    (stream("I would rather not say."), "unparsed", "Claude's answer couldn't be read"),
    (stream(error="server_error", error_text="API Error: Repeated 529 Overloaded errors"), "error",
     "API Error: Repeated 529 Overloaded errors"),
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
    forks.answer = stream(json.dumps(ANSWER), model="claude-opus-4-8")
    lv, p = _attach(cwd, tmp_path)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    await _settle()
    assert [r["name"] for r in cards] == ["Reply Network"] and _runs()[0]["fallback"] == "claude-opus-4-8"
    assert _shown_notice()["text"] == "This view proposal came from Opus 4.8: Claude's safeguards switched models."
    cards.clear()
    forks.answer = stream(json.dumps({"show": False, "why": "Nothing new.", "proposal": None}))
    _append(p, lv, _turn("And now?", "cut-2"))
    await _settle()
    assert _shown_notice() is None and _runs()[-1]["show"] is False


def test_a_1m_fork_s_bare_model_is_no_fallback():
    st = proposer.read_stream(stream("{}", model="claude-opus-5-5"))
    assert proposer.fallback_of(st, "claude-opus-5-5[1m]") is None
    assert proposer.fallback_of(proposer.read_stream(stream("{}", model="claude-opus-4-8")),
                                "claude-opus-5-5[1m]") == "claude-opus-4-8"


async def test_an_answer_that_comes_after_the_analyst_wrote_again_shows_no_card(cwd, tmp_path, cards, forks,
                                                                             monkeypatch):
    lv, p = _attach(cwd, tmp_path)
    real = forks.answer

    async def slow(lv_, cut, prompt, model_id, effort, speed):
        forks.append({"cut": cut})
        with p.open("a") as f:
            f.write(json.dumps(_human("A new question")) + "\n")
        session.tail_once(lv)
        return {"code": 0, "stdout": real, "stderr": "", "timed_out": False, "seconds": 1.0}

    monkeypatch.setattr(proposer, "_fork", slow)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    await _settle()
    assert cards == [] and _runs()[0]["status"] == "stale"


async def test_try_again_runs_now_or_says_why_not(cwd, tmp_path, cards, forks, monkeypatch):
    lv, p = _attach(cwd, tmp_path)
    assert proposer.run_now(CORPUS) == {"started": False, "reason": "Main has no finished turn to start from."}
    monkeypatch.setattr(proposer, "DEBOUNCE_MAIN_S", 60.0)
    _append(p, lv, _turn("Who replies?", "cut-1"))
    assert proposer.run_now(CORPUS) == {"started": True}
    await _settle()
    assert [f["cut"] for f in forks] == ["cut-1"] and len(cards) == 1
    assert proposer.run_now(CORPUS) == {"started": False, "reason": "A view proposal waits for the analyst."}
    assert proposer.pending(CORPUS) is None, "a refused Try again leaves no job"
    monkeypatch.setattr(views, "propose_enabled", lambda c: False)
    assert proposer.run_now(CORPUS) == {"started": False, "reason": "View proposals are off."}


# ----------------------------------------------------------------------------- the command and its environment


def _lv(**kw: Any) -> session.Live:
    lv = session.Live(CORPUS, SID, "/corpus", "/t.jsonl", None)
    for k, v in kw.items():
        setattr(lv, k, v)
    return lv


def test_the_fork_command_resumes_main_at_the_cut_with_no_tool(monkeypatch):
    monkeypatch.setattr(config, "CLI_PATH", "/bin/claude")
    argv = proposer._argv(_lv(), "cut-1", "claude-opus-5-5", "medium", "standard")
    assert argv[:-5] == ["/bin/claude", "-p", "--resume", SID, "--resume-session-at", "cut-1", "--fork-session",
                         "--no-session-persistence", "--model", "claude-opus-5-5", "--effort", "medium", "--tools", "",
                         "--strict-mcp-config", "--disable-slash-commands", "--safe-mode", "--setting-sources", "user",
                         "--permission-mode", "dontAsk"]
    assert argv[-5] == "--settings" and argv[-3:] == ["--output-format", "stream-json", "--verbose"]
    settings = json.loads(argv[-4])
    assert settings == {"fastMode": False, "ultracode": False, "env": {"CLAUDE_CODE_EFFORT_LEVEL": "medium"},
                        "advisorModel": "off"}
    haiku = proposer._argv(_lv(), "cut-1", "claude-haiku-4-5-20251001", "medium", "standard")
    assert "--effort" not in haiku


def test_a_long_session_forks_on_the_1m_window(monkeypatch):
    monkeypatch.setattr(config, "call_settings",
                        lambda c, role: {"model": "claude-opus-5-5", "effort": "medium", "speed": "standard"})
    assert proposer._model(CORPUS, _lv(context_tokens=10_000), "x" * 4000)[0] == "claude-opus-5-5"
    assert proposer._model(CORPUS, _lv(context_tokens=179_000), "x" * 8000)[0] == "claude-opus-5-5[1m]"


def test_the_fork_s_environment_has_main_s_config_dir_and_none_of_thimble_s(monkeypatch):
    monkeypatch.setenv("THIMBLE_SESSION", "s1")
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-5")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/served")
    monkeypatch.setattr(config, "_served_config", None)
    env = proposer._env(_lv(config_known=True, config="/main-cc"))
    assert env["CLAUDE_CONFIG_DIR"] == "/main-cc" and env["ANTHROPIC_MODEL"] == "" and env["SHLVL"] == "1"
    assert not [k for k in env if k.startswith("THIMBLE_")]
    assert "CLAUDE_CONFIG_DIR" not in proposer._env(_lv(config_known=True, config=None))
    assert proposer._env(_lv())["CLAUDE_CONFIG_DIR"] == "/served", "unknown: the served config dir"


async def test_a_fork_that_cannot_start_fails_with_its_reason(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CLI_PATH", str(tmp_path / "no-claude"))
    got = await proposer._fork(_lv(cwd=str(tmp_path)), "cut", "prompt", "claude-opus-5-5", "medium", "standard")
    assert got["code"] is None and "could not start" in got["stderr"]
    assert proposer.error_line(proposer.read_stream(""), got["stderr"], None).startswith("Claude Code could not start")


# ----------------------------------------------------------------------------- the prompt and the answer


def test_the_prompt_holds_the_views_the_orientation_and_now(monkeypatch):
    monkeypatch.setattr(views, "list_proposals", lambda c: [
        {"slug": "a", "name": "Reply Network", "description": "Who replies.", "status": "dropped",
         "offered": {"at": "2026-10-14T10:05:00Z", "after": "main"}, "answer": "rejected"},
        {"slug": "b", "name": "Run Timeline", "description": "Each run in time.", "status": "building",
         "offered": {"at": "2026-10-14T10:20:00Z", "after": "orientation"}, "answer": "accepted"},
        {"slug": "c", "name": "Vtt Reader", "description": "Cues.", "status": "dropped", "claims": ["**/*.vtt"],
         "proposed_by": "files", "offered": {"at": "2026-10-14T10:30:00Z", "after": "file"}, "answer": "rejected"},
        {"slug": "d", "name": "Board", "description": "The board.", "status": "failed"},
        {"slug": "e", "name": "Legacy", "description": "Old.", "status": "suggested"},
    ])
    monkeypatch.setattr(views, "list_views", lambda c: [{"slug": "f", "name": "Pages", "description": "Each page."}])
    monkeypatch.setattr(views, "deleted_proposals", lambda c: [{"name": "Gone"}])
    monkeypatch.setattr(orientation, "read_run", lambda c: {"status": "done", "started": "2026-10-14T09:00:00Z",
                                                            "ended": "2026-10-14T09:40:00Z", "chats": {}})
    monkeypatch.setattr(orientation, "summary", lambda c: "# Summary\n\nTwelve agents share one board.")
    text = proposer.assemble(CORPUS, {"after": ["main"]})
    assert text.startswith("# View proposals")
    assert "- Reply Network: Who replies. You proposed it at 10:05, and the analyst rejected it." in text
    assert "- Run Timeline: Each run in time. You proposed it at 10:20, and the analyst accepted it; building." in text
    assert ("- Vtt Reader: Cues. thimble proposed it when the analyst opened a .vtt file, at 10:30, and the analyst "
            "rejected it.") in text
    assert "- Board: The board. The build failed." in text and "Legacy" not in text
    assert "- Pages: Each page. Built." in text and "- Gone: the analyst deleted this view." in text
    assert "An orientation ran beside the session from 09:00 to 09:40" in text and "### Summary" in text
    assert "The analyst has asked nothing in a side thread." in text
    assert text.rstrip().endswith("The session has just answered the analyst's last message, above.")
    assert "## The cards" not in text and "offer" not in text.lower() and "banner" not in text.lower()


def test_the_terminal_prompt_names_the_row_above_the_prompt():
    from app import prompts

    browser, terminal = prompts.load("view-propose", "browser"), prompts.load("view-propose", "terminal")
    assert "as a card above the chat's composer" in browser and "in Files" in browser
    assert "as a row above Claude Code's prompt" in terminal and "in thimble's panel in the terminal" in terminal


def test_parse_takes_a_fenced_object_a_no_and_a_missing_why():
    obj, err = proposer.parse("Here:\n```json\n" + json.dumps(ANSWER) + "\n```\n")
    assert err is None and obj["proposal"]["name"] == "Reply Network"
    obj, err = proposer.parse('{"show": false, "why": "Nothing new.", "proposal": null}')
    assert err is None and obj["show"] is False and obj["proposal"] is None
    obj, err = proposer.parse(json.dumps({**ANSWER, "why": None, "proposal": {**ANSWER["proposal"], "claims": "a/*"}}))
    assert err is None and obj["why"] == "" and obj["proposal"]["claims"] == ["a/*"]
    assert proposer.parse("no json")[0] is None
    assert proposer.parse(json.dumps({"show": True, "why": "x", "proposal": {"name": "A"}}))[1] == \
        "`proposal.description` is missing"


# ----------------------------------------------------------------------------- session.py


def test_the_turn_s_cut_and_who_opened_it_are_kept_and_survive_a_pass(cwd, tmp_path, monkeypatch):
    heard: list[dict] = []
    monkeypatch.setattr(proposer, "turn_ended", lambda c, **kw: heard.append(kw))
    lv, p = _attach(cwd, tmp_path)
    usage = {"input_tokens": 3, "cache_read_input_tokens": 40_000, "cache_creation_input_tokens": 2_000}
    _append(p, lv, [_human("Who replies?"), {"type": "assistant", "message": {
        "role": "assistant", "model": "claude-opus-5-5", "usage": usage, "content": [_say("A and B.")]}}])
    assert lv.turn_analyst and lv.context_tokens == 42_003
    kept = session._turn_state(lv)
    other = session.Live(CORPUS, SID, cwd, str(p), None)  # the next pass of the mirror in terminal mode
    session._take_turn(other, kept)
    assert other.turn_analyst and other.context_tokens == 42_003
    _append(p, lv, [_end("cut-9")])
    assert heard == [{"sid": SID, "analyst": True, "cut": "cut-9"}] and lv.last_cut == "cut-9"
    assert session._turn_state(lv)["last_cut"] == "cut-9"
    note = "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>"
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("ok")), _end("cut-10")])
    assert heard[-1] == {"sid": SID, "analyst": False, "cut": "cut-10"}


async def test_the_proposer_writes_its_card_through_views_offer(cwd, tmp_path, forks, monkeypatch):
    """With the real storage: the card is a `suggested` row with `offered`, which open_offer gives."""
    monkeypatch.setenv(proposer.PROPOSE_ENV, "on")
    monkeypatch.setattr(views, "propose_enabled", lambda c: True)
    monkeypatch.setattr(views, "build_problem_for", lambda c: "")
    monkeypatch.setattr(proposer, "DEBOUNCE_MAIN_S", 0.0)
    await _one_turn(cwd, tmp_path)
    row = views.open_offer(CORPUS)
    assert row is not None and row["name"] == "Reply Network" and row["offered"]["after"] == "main"
