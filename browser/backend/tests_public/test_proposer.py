"""proposer.py: the view proposer. A turn of main that answered the analyst runs one fork of main's session at the
turn's cut, which may show a view proposal card (views.offer). The fork is faked (proposer._fork) with the stream-json
Claude Code prints, and the view proposal storage (views.offer, open_offer, propose_enabled) is faked."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from app import config, notices, proposer, session, views

# model calls go through Claude Code, which the tests fake (conftest claude_code_sign_in)
pytestmark = pytest.mark.usefixtures("claude_code_sign_in")

CORPUS = "mini"
SID = "a0b0c0d0-0000-4000-8000-0000000000a1"
END = {"type": "system", "subtype": "turn_duration"}
ANSWER = {"show": True, "why": "The analyst keeps comparing who replies to whom.",
          "proposal": {"name": "Reply Network", "description": "Who replies to whom, as a network.",
                       "task": "Compare how the agents coordinate.", "claims": ["board.jsonl"]}}


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


def stream(text: str, *, model: str = "claude-opus-5-5", cost: float = 2.5) -> str:
    """Claude Code's stream-json output of one `claude -p` call: init, the reply, the result."""
    evs: list[dict] = [{"type": "system", "subtype": "init", "model": model, "tools": [], "mcp_servers": []},
                       {"type": "assistant", "message": {"model": model, "stop_reason": "end_turn",
                                                         "content": [{"type": "text", "text": text}]}},
                       {"type": "result", "subtype": "success", "is_error": False, "result": text,
                        "total_cost_usd": cost}]
    return "\n".join(json.dumps(e) for e in evs) + "\n"


@pytest.fixture()
def forks(monkeypatch) -> list[dict]:
    """The fork faked: each call is recorded (cut, prompt, model) and answers with the proposal of ANSWER."""
    got: list[dict] = []

    async def fake(lv, cut, prompt, model_id, effort, speed):
        got.append({"cut": cut, "prompt": prompt, "model": model_id, "effort": effort, "sid": lv.sid})
        return {"code": 0, "stdout": stream("```json\n" + json.dumps(ANSWER) + "\n```"), "stderr": "",
                "timed_out": False, "seconds": 1.0}

    monkeypatch.setattr(proposer, "_fork", fake)
    return got


@pytest.fixture()
def cwd() -> str:
    return str(config.corpus_dir(CORPUS))


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
