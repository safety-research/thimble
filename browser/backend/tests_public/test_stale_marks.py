"""marks.py: a citation whose source changed after its check. A verified mark keeps what its evidence rests on; when the
page reads a chat, the server compares those sources with their files (refresh_sources), and Repair checks a stale mark
again against the files as they are now, only its own calls counting as computed evidence. The fork is replaced here;
the marks, the validator and the records are real."""
from __future__ import annotations

import asyncio
import json
import os

import pytest

from app import agents, config, marks, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000ab"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, data_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    told: list[str] = []
    monkeypatch.setattr(marks, "_tell", lambda c, text: told.append(text))
    monkeypatch.setattr(marks, "_notice", lambda c, text, details=None: told.append("notice: " + text))
    yield told
    session._live.clear()


def _answer(items: list[dict]) -> str:
    return "Checked.\n```json\n" + json.dumps(items) + "\n```"


def _edit(path, text: str) -> None:
    """The file written anew, its mtime a second later, as a later write leaves it."""
    st = path.stat()
    path.write_text(text)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def test_a_mark_whose_cited_line_changed_is_stale_and_repair_checks_it_against_the_file_now(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nRun it on port 8000.\nThe tests use pytest.\n")
    from types import SimpleNamespace

    lv = SimpleNamespace(sid=SID, cwd=str(folder), config=None, config_known=False, transcript_path=None, model="",
                         effort="", context_tokens=0, last_cut="cut-1")
    monkeypatch.setattr(session, "current", lambda c: lv if c == CORPUS else None)
    ev = marks.evidence()
    fresh: list[bool] = []
    check_all = ev.check_all
    monkeypatch.setattr(ev, "check_all", lambda *a, **k: (fresh.append(bool(a[9] if len(a) > 9 else k.get("fresh"))), check_all(*a, **k))[1])
    prompts: list[str] = []

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        port = "9000" if "9000" in notes.read_text() else "8000"
        out = [{"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": f"port {port}"},
                "status": "verified" if port == "8000" else "corrected", "correction": None if port == "8000" else {"words": f"port {port}"},
                "reason": "line 2 says so"}]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = marks.new_turn()
    asyncio.run(marks.start_check(CORPUS, {"sid": SID, "cwd": str(folder), "transcript_path": None}, turn,
                                  ["The app runs on [port 8000](#)."], "cut-1", fork=fork))
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "verified" and [s["file"] for s in m["sources"]] == ["notes.md"], m
    assert marks.stale_sources(m) == []
    # another line changed: the cited line reads as the check read it
    _edit(notes, "# app, the habit tracker\nRun it on port 8000.\nThe tests use pytest.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    assert marks.stale_sources(marks.stored(CORPUS, turn)["items"][0]) == []
    # the cited line changed: the mark is stale, and the page reads it so from the chat's records
    _edit(notes, "# app, the habit tracker\nRun it on port 9000.\nThe tests use pytest.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert [s["file"] for s in marks.stale_sources(m)] == ["notes.md"], m
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    last = [r for r in agents.read_events(log_path) if r["type"] == "marks" and r["turn"] == turn][-1]
    assert last["items"][0]["sources"][0]["changed"] is True

    async def go():
        assert await marks.repair(CORPUS, turn=turn, n=1, fork=fork) == ""
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))

    asyncio.run(go())
    assert "The analyst pressed Repair on citation 1, since notes.md changed after its first check." in prompts[-1]
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "corrected" and m["shown"] == "port 9000" and marks.stale_sources(m) == [], m
    # the first check took any call as evidence; the repair of the stale mark only its own
    assert fresh == [False, True]
