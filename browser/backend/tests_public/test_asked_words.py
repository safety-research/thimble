"""e and c on words the analyst selected in an answer, as the terminal's keys act on them: POST /explain writes the
explainer of the words with the terminal's explain-expand text and stores it as an Explainers comment on the sentence
that holds them (explain.py), and POST /marks/cite makes them a citation of the answer, checked at once with the
checker's text and the terminal's note that the analyst opened it (marks.cite). The forks are replaced here; the texts,
the stores, the validator and the records are real."""
from __future__ import annotations

import json
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import agents, answer_comments, checks, config, marks, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000bb"
QUESTION = "Why do uploads fail?"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, monkeypatch):
    session._live.clear()
    told: list[str] = []
    monkeypatch.setattr(marks, "_tell", lambda c, text: told.append(text))
    monkeypatch.setattr(marks, "_notice", lambda c, text, details=None: told.append("notice: " + text))
    lv = SimpleNamespace(sid=SID, cwd=str(config.corpus_dir(CORPUS)), config=None, config_known=False,
                         transcript_path=None, model="", effort="", context_tokens=0, last_cut="cut-1")
    monkeypatch.setattr(session, "current", lambda c: lv if c == CORPUS else None)
    yield told
    session._live.clear()


def _answered(text: str, chat: str = agents.MAIN_ID) -> str:
    """An answer of main's (or of a side thread's run) in the chat's log, closed by its `done` record; its turn."""
    turn = marks.new_turn()
    if chat == agents.MAIN_ID:
        for rec in ({"type": "user", "by": "browser", "text": QUESTION}, {"type": "text", "delta": text},
                    {"type": "done", "turn": turn}):
            agents.mirror(CORPUS, rec.pop("type"), **rec)
    else:
        log_path = agents.paths(CORPUS, chat)[1]
        for rec in ({"type": "user", "by": "browser", "text": QUESTION}, {"type": "text", "delta": text},
                    {"type": "done", "turn": turn, "ts": "2026-11-18T00:00:00+00:00"}):
            agents.append(log_path, rec)
    return turn


def test_e_writes_the_explainer_of_the_selected_words_with_the_terminal_s_text_as_an_explainers_comment(monkeypatch):
    """The fork reads the terminal's explain-expand text, then the words, the analyst's question, the answer and the
    lines of the file it links to; its explainer is a comment of the Explainers check on the sentence that holds the
    words, which the chat lists. The same words again open it with no call, and with Explainers off for the chat e
    says how to turn it on."""
    from app.main import app

    folder = config.corpus_dir(CORPUS)
    rel = next(p for p in sorted(folder.rglob("*.jsonl")) if p.stat().st_size)
    path = str(rel.relative_to(folder))
    turn = _answered(f"Uploads fail once the retry budget runs out. See [the log]({path}#L1).")
    seen: list[str] = []

    async def fork(c, main, cut, prompt):
        seen.append(prompt)
        reply = {"body": "How many times the client sends a failed upload again.", "here": f"[the first line]({path}#L1-2)."}
        return {"answer": json.dumps(reply), "calls": [], "error": None}

    monkeypatch.setattr(marks, "run_fork", fork)
    with TestClient(app) as client:
        got = client.post(f"/api/ws/{CORPUS}/explain", json={"chat": "main", "turn": turn, "words": " retry  budget "})
        assert got.status_code == 200, got.text
        cm = got.json()
        assert cm["check"] == "explainers" and cm["turn"] == turn and cm["ref"] == f"answer:{turn}#s1"
        (prompt,) = seen
        assert prompt.startswith("thimble is") and "The analyst picked words in one of Claude's answers" in prompt
        assert f"The term: retry budget\n\nThe analyst's question: {QUESTION}" in prompt
        assert f"See [the log]({path}#L1)." in prompt and f"--- {path} (lines 1–" in prompt
        listed = client.get(f"/api/ws/{CORPUS}/answer-comments").json()["comments"]
        (shown,) = [x for x in listed if x["id"] == cm["id"]]
        assert shown["words"] == "retry budget" and shown["check_name"] == "Explainers"
        assert shown["text"] == "retry budget: How many times the client sends a failed upload again."
        assert shown["details"] == f"the first line [[{path}#L1-L2]]."
        # the same words again: the explainer on them, with no call
        again = client.post(f"/api/ws/{CORPUS}/explain", json={"chat": "main", "turn": turn, "words": "retry budget"})
        assert again.json()["id"] == cm["id"] and len(seen) == 1
        checks.edit(CORPUS, "explainers", shown=False)
        off = client.post(f"/api/ws/{CORPUS}/explain", json={"chat": "main", "turn": turn, "words": "uploads"})
        assert off.status_code == 409 and "Turn it on under Comments" in off.json()["detail"]
    assert answer_comments._read(CORPUS)[0]["asked"] is True


def test_c_makes_the_selected_words_a_citation_of_the_answer_checked_now_with_the_terminal_s_note(_fresh, monkeypatch):
    """A citation of words of an answer that has none of Claude's: kept as the turn's marks with its row and place, its
    check one fork of main whose prompt is the checker's text for it, then the terminal's note that the analyst opened
    it; the validator decides, and the chat's log holds the marks record of each change."""
    from app.main import app

    folder = config.corpus_dir(CORPUS)
    rel = next(p for p in sorted(folder.rglob("*.jsonl")) if p.stat().st_size)
    quoted = rel.read_text(encoding="utf-8").splitlines()[0][:24]
    path = str(rel.relative_to(folder))
    text = f'The log opens with "{quoted}" and goes on.'
    turn = _answered(text)
    seen: list[str] = []

    async def fork(c, main, cut, prompt):
        seen.append(prompt)
        out = [{"mark": 1, "kind": "quote", "evidence": {"file": path, "line": 1, "substring": quoted},
                "status": "verified", "correction": None, "reason": "the first line says it"}]
        return {"answer": "```json\n" + json.dumps(out) + "\n```", "calls": [], "error": None}

    monkeypatch.setattr(marks, "run_fork", fork)
    start = text.index(quoted)
    body = {"chat": "main", "turn": turn, "row": 1, "start": start, "end": start + len(quoted), "words": quoted,
            "sentence": f'The log opens with "[{quoted}]" and goes on.'}
    with TestClient(app) as client:
        got = client.post(f"/api/ws/{CORPUS}/marks/cite", json=body)
        assert got.status_code == 200, got.text
        assert got.json() == {"turn": turn, "n": 1}
        for _ in range(500):
            if (marks.stored(CORPUS, turn) or {}).get("items", [{}])[0].get("status") != "checking":
                break
            time.sleep(0.01)
        # the same words again: the citation already on them
        assert client.post(f"/api/ws/{CORPUS}/marks/cite", json=body).json() == {"turn": turn, "n": 1}
    (prompt,) = seen
    assert f'1. [{quoted}] in: The log opens with "[{quoted}]" and goes on.' in prompt
    assert prompt.endswith("The analyst opened citation 1 to read its evidence. It may stand in an earlier reply than your last.")
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "verified" and m["asked"] is True and (m["row"], m["start"], m["end"]) == (1, start, start + len(quoted))
    records = [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r["type"] == "marks"]
    assert records[0]["items"][0]["status"] == "checking" and records[-1]["items"][0]["status"] == "verified"


def test_e_on_a_side_thread_s_answer_keeps_its_explainer_with_that_thread(monkeypatch):
    """A side thread's run ends with an answer in the thread's own log: e on its words reads that answer and the
    question asked in the thread, and its comment names the thread, which the chat lists with it."""
    from app.main import app

    meta = agents.new_thread(CORPUS, "chat:main#1", "the retry budget")
    turn = _answered("The retry budget is five tries, as upload.py sets it.", chat=meta["id"])
    seen: list[str] = []

    async def fork(c, main, cut, prompt):
        seen.append(prompt)
        return {"answer": json.dumps({"body": "Five tries in all.", "here": ""}), "calls": [], "error": None}

    monkeypatch.setattr(marks, "run_fork", fork)
    with TestClient(app) as client:
        got = client.post(f"/api/ws/{CORPUS}/explain", json={"chat": meta["id"], "turn": turn, "words": "five tries"})
        assert got.status_code == 200, got.text
        assert f"The analyst's question: {QUESTION}" in seen[0] and "The retry budget is five tries" in seen[0]
        (shown,) = client.get(f"/api/ws/{CORPUS}/answer-comments").json()["comments"]
        assert shown["chat"] == meta["id"] and shown["turn"] == turn and shown["words"] == "five tries"
