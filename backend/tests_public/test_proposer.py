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

from app import agents, config, notices, proposer, session, views
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


@pytest.mark.parametrize("answer,status,reason", [
    ({"code": None, "stdout": "", "stderr": "", "timed_out": True, "seconds": 300.0}, "timeout",
     "Claude didn't answer within 5 minutes"),
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
