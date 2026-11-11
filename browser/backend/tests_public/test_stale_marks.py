"""marks.py: a citation whose source changed after its check. A verified mark keeps what its evidence rests on, and the
index of cited files lists the marks that rest on each; when the page reads a chat, the server stats each cited file
and compares only the marks that rest on a file whose stat changed (refresh_sources). Repair checks a stale mark again
against the files as they are now, only its own calls counting as computed evidence, and so each Repair of it until one
of those checks passes; that check takes the other stale marks of its sentence with it. The fork is replaced here; the
marks, the validator and the records are real."""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace

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


def _main(monkeypatch, folder) -> None:
    lv = SimpleNamespace(sid=SID, cwd=str(folder), config=None, config_known=False, transcript_path=None, model="",
                         effort="", context_tokens=0, last_cut="cut-1")
    monkeypatch.setattr(session, "current", lambda c: lv if c == CORPUS else None)


def _fresh_calls(monkeypatch) -> list[bool]:
    """Whether each check the validator ran was a fresh one."""
    ev = marks.evidence()
    fresh: list[bool] = []
    check_all = ev.check_all
    monkeypatch.setattr(ev, "check_all", lambda *a, **k: (fresh.append(bool(a[9] if len(a) > 9 else k.get("fresh"))), check_all(*a, **k))[1])
    return fresh


def _check(folder, text: str, fork) -> str:
    turn = marks.new_turn()
    asyncio.run(marks.start_check(CORPUS, {"sid": SID, "cwd": str(folder), "transcript_path": None}, turn, [text], "cut-1", fork=fork))
    return turn


def _repair(turn: str, fork) -> None:
    async def go():
        assert await marks.repair(CORPUS, turn=turn, n=1, fork=fork) == ""
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))

    asyncio.run(go())


def test_a_mark_whose_cited_line_changed_is_stale_and_repair_checks_it_against_the_file_now(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nRun it on port 8000.\nThe tests use pytest.\n")
    _main(monkeypatch, folder)
    fresh = _fresh_calls(monkeypatch)
    prompts: list[str] = []

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        port = "9000" if "9000" in notes.read_text() else "8000"
        out = [{"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": f"port {port}"},
                "status": "verified" if port == "8000" else "corrected", "correction": None if port == "8000" else {"words": f"port {port}"},
                "reason": "line 2 says so"}]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = _check(folder, "The app runs on [port 8000](#).", fork)
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

    _repair(turn, fork)
    assert ("The analyst pressed Repair on citation 1, since notes.md changed after its first check. What this session read or "
            "printed before that change may be out of date. A copy of a file from before the change is no evidence.") in prompts[-1]
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "corrected" and m["shown"] == "port 9000" and marks.stale_sources(m) == [], m
    assert "fresh" not in m
    # the first check took any call as evidence; the repair of the stale mark only its own
    assert fresh == [False, True]


def test_a_stale_mark_whose_repair_failed_is_repaired_against_the_file_now_until_a_check_passes(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nRun it on port 8000.\n")
    _main(monkeypatch, folder)
    fresh = _fresh_calls(monkeypatch)
    prompts: list[str] = []
    answers = [
        {"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": "port 8000"}, "status": "verified", "reason": "line 2"},
        {"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": "port 9000"}, "status": "wrong", "reason": "Line 2 now says port 9000."},
        {"mark": 1, "kind": "quote", "evidence": {"file": "notes.md", "line": 2, "substring": "port 9000"}, "status": "corrected",
         "correction": {"words": "port 9000"}, "reason": "line 2"},
    ]

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        return {"answer": _answer([answers.pop(0)]), "calls": [], "error": None}

    turn = _check(folder, "The app runs on [port 8000](#).", fork)
    _edit(notes, "# app\nRun it on port 9000.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    _repair(turn, fork)
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "failed" and m["fresh"] == ["notes.md"], m
    # a second Repair: the file as it is now again, the session's earlier output no evidence
    _repair(turn, fork)
    assert "since notes.md changed after its first check" in prompts[-1]
    assert fresh == [False, True, True]
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "corrected" and m["shown"] == "port 9000" and "fresh" not in m, m


def test_repair_of_one_of_two_stale_marks_of_a_sentence_repairs_both_with_one_rewrite(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes = folder / "notes.md"
    notes.write_text("# app\nuvicorn app:app --port 8000\nOpen http://localhost:8000.\n")
    _main(monkeypatch, folder)
    prompts: list[str] = []
    was = "The app runs on [port 8000]: start it with `uvicorn ... --port 8000`, then open [http://localhost:8000]."
    now = "The app runs on [port 9000]: start it with `uvicorn ... --port 9000`, then open [http://localhost:9000]."

    async def fork(c, main, cut, prompt):
        prompts.append(prompt)
        port = "9000" if "9000" in notes.read_text() else "8000"
        out = [{"mark": n, "kind": "quote", "evidence": {"file": "notes.md", "line": n + 1, "substring": sub}, "reason": "it says so",
                **({"status": "corrected", "correction": {"words": sub, "sentence": now}} if port == "9000" else {"status": "verified"})}
               for n, sub in ((1, f"port {port}"), (2, f"http://localhost:{port}"))]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = _check(folder, "The app runs on [port 8000](#): start it with `uvicorn ... --port 8000`, then open [http://localhost:8000](#).", fork)
    _edit(notes, "# app\nuvicorn app:app --port 9000\nOpen http://localhost:9000.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    assert [len(marks.stale_sources(m)) for m in marks.stored(CORPUS, turn)["items"]] == [1, 1]
    # Repair on the first: one check of both, its request naming the second
    _repair(turn, fork)
    assert f"1. [port 8000] in: {was}\n2. [http://localhost:8000] in: {was}" in prompts[-1]
    assert "Citation 2 stands in the same sentence, and notes.md changed after its first check too." in prompts[-1]
    items = marks.stored(CORPUS, turn)["items"]
    assert [(m["status"], m["shown"], m.get("rewrite")) for m in items] == [("corrected", "port 9000", now), ("corrected", "http://localhost:9000", now)], items
    assert all(marks.stale_sources(m) == [] and "fresh" not in m for m in items), items


def test_a_pass_reads_only_the_replies_whose_marks_rest_on_a_file_that_changed_and_moved_lines_take_their_numbers(_fresh, monkeypatch):
    folder = config.corpus_dir(CORPUS)
    notes, other = folder / "notes.md", folder / "other.md"
    notes.write_text("# app\nRun it on port 8000.\nThe tests use pytest.\n")
    other.write_text("# other\nIt needs Python 3.12.\n")
    _main(monkeypatch, folder)

    def fork_for(file: str, sub: str):
        async def fork(c, main, cut, prompt):
            line = next(k for k, t in enumerate((folder / file).read_text().splitlines(), 1) if sub in t)
            return {"answer": _answer([{"mark": 1, "kind": "quote", "evidence": {"file": file, "line": line, "substring": sub},
                                        "status": "verified", "reason": "it says so"}]), "calls": [], "error": None}
        return fork

    a = _check(folder, "The app runs on [port 8000](#).", fork_for("notes.md", "port 8000"))
    b = _check(folder, "It needs [Python 3.12](#).", fork_for("other.md", "Python 3.12"))
    index = json.loads((config.workspace_dir(CORPUS) / "marks" / "cited.json").read_text())
    assert {os.path.basename(p): f["by"] for p, f in index["files"].items()} == {"notes.md": {a: [1]}, "other.md": {b: [1]}}
    read: list[str] = []
    stored = marks.stored
    monkeypatch.setattr(marks, "stored", lambda c, turn: (read.append(turn), stored(c, turn))[1])
    # nothing changed: no reply read
    asyncio.run(marks.refresh_sources(CORPUS))
    assert read == []
    # a line added above the cited one: only that reply is read, and its mark stays verified at the line it moved to
    _edit(notes, "# app\nA habit tracker.\nRun it on port 8000.\nThe tests use pytest.\n")
    asyncio.run(marks.refresh_sources(CORPUS))
    assert set(read) == {a}
    (m,) = stored(CORPUS, a)["items"]
    assert m["status"] == "verified" and marks.stale_sources(m) == [], m
    assert m["sources"][0]["line"] == "3" and m["evidence"]["line"] == "3"
    assert [x["n"] for x in m["evidence"]["lines"]] == [3, 4]
    # and the page reads it so from the chat's records
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    last = [r for r in agents.read_events(log_path) if r["type"] == "marks" and r["turn"] == a][-1]
    assert last["items"][0]["evidence"]["line"] == "3"
