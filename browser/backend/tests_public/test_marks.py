"""marks.py: the checks in the chat. Main cites claims as `[words](#)`; at the end of its turn a fork of it (the checker,
the terminal plugin's checker.md) proposes evidence for each, and the terminal's validator (plugin/engine/kernel/
evidence.py) decides what the analyst sees. The fork is replaced here; the marks, the validator and the records are
real."""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import pytest
from conftest import NO_MARKER, STDIN_WARNING, late_stdin_claude

from app import agents, config, marks, sdk, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000aa"
# the reason of a citation of a file outside every folder a cited file may lie in, which names no path (B19)
OUTSIDE = "The check cited a file outside the folder this session works in."


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    told: list[tuple[str, str]] = []
    monkeypatch.setattr(marks, "_tell", lambda c, text: told.append((c, text)))
    monkeypatch.setattr(marks, "_notice", lambda c, text, details=None: told.append((c, "notice: " + text)))
    yield told
    session._live.clear()


def _log() -> list[dict]:
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    return agents.read_events(log_path)


def _answer(items: list[dict]) -> str:
    return "Checked.\n```json\n" + json.dumps(items) + "\n```"


def test_a_reply_s_marks_are_checked_and_the_validator_decides(_fresh, tmp_path):
    """Three marks: a quote the file holds (verified), a count the fork's own Python printed differently (corrected),
    and a quote the file does not hold (flagged as not confirmed, whatever the fork said). Main hears what changed."""
    folder = config.corpus_dir(CORPUS)
    rel = next(p for p in sorted(folder.rglob("*.jsonl")) if p.stat().st_size)
    first = rel.read_text(encoding="utf-8").splitlines()[0]
    quoted = first[:24]
    path = str(rel.relative_to(folder))
    texts = [f'It opens with ["{quoted}"](#). Then [15 of 40](#) runs failed.', 'One said ["no such words here"](#).']
    seen: list[str] = []

    async def fork(c, main, cut, prompt):
        seen.append(prompt)
        code = "a = 3 * 4\nb = a * 10 // 3\nprint(f'{a} of {b}')"
        calls = [{"command": f"python3 - <<'PY'\n{code}\nPY", "output": "12 of 40\n", "by": "checker"}]
        n = {w: i for i, w in ((1, quoted), (2, "15 of 40"), (3, "no such words here"))}
        out = []
        if '"' + quoted in prompt or quoted in prompt:
            out.append({"mark": n[quoted], "kind": "quote", "evidence": {"file": path, "line": 1, "substring": quoted},
                        "status": "verified", "correction": None, "reason": "the first line says it"})
        if "15 of 40" in prompt:
            out.append({"mark": 2, "kind": "computed", "evidence": {"output": "12 of 40"}, "status": "corrected",
                        "correction": {"words": "12 of 40"}, "reason": "12 of the 40 runs failed"})
        if "no such words here" in prompt:
            out.append({"mark": 3, "kind": "quote", "evidence": {"file": path, "line": 1, "substring": "no such words here"},
                        "status": "verified", "correction": None, "reason": "it says so"})
        return {"answer": _answer(out), "calls": calls, "error": None}

    turn = marks.new_turn()
    main = {"sid": SID, "cwd": str(folder), "transcript_path": None}
    asyncio.run(marks.start_check(CORPUS, main, turn, texts, "cut-uuid", fork=fork))
    got = {m["n"]: m for m in marks.stored(CORPUS, turn)["items"]}
    assert got[1]["status"] == "verified", got[1]
    assert got[2]["status"] == "corrected" and got[2]["shown"] == "12 of 40", got[2]
    assert got[3]["status"] == "failed" and got[3].get("failedBy") == "evidence", got[3]
    records = [r for r in _log() if r["type"] == "marks" and r["turn"] == turn]
    assert records[0]["items"][0]["status"] == "checking" and records[-1]["items"] == marks.stored(CORPUS, turn)["items"]
    assert all("{{" not in p for p in seen)
    (c, said), = [t for t in _fresh if not t[1].startswith("notice")]
    assert c == CORPUS and '"15 of 40" is corrected to "12 of 40"' in said and "not confirmed" in said


TABLE = {"text/html": "<table><tr><th>agent</th><th>merged</th><th>total</th></tr>"
                      "<tr><th>agent-03</th><td>4</td><td>10</td></tr><tr><th>agent-07</th><td>12</td><td>40</td></tr></table>"}


def _seed_card(takeaway: str, outputs: list[dict]) -> str:
    from app import notebook

    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Board", role="exploration")
    cell = notebook.new_cell("code", "run", "Merged pull requests by agent", nb["id"], code="print()")
    cell.update(status="ok", outputs=outputs, takeaway=takeaway)
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    return cell["id"]


def test_a_takeaway_s_marks_are_checked_with_main_s_reply_and_a_card_s_cell_is_their_evidence(_fresh):
    """The checker reads the cards' index first; a card's cell is evidence the validator reads back. A takeaway's marks
    are checked with main's next reply, their line naming the card, and what the check found is kept on the card."""
    from app import notebook

    cid = _seed_card("agent-07 merged [12](#) of [40](#) pull requests.", [TABLE])
    seen: list[str] = []

    async def fork(c, main, cut, prompt):
        seen.append(prompt)
        index = next(w for w in prompt.split("`") if w.endswith("cards-index.tsv"))
        listed = Path(index).read_text(encoding="utf-8")
        assert f"card:{cid}#merged/agent-07\t12" in listed and f"card:{cid}#total/agent-07\t40" in listed
        out = [{"mark": 1, "kind": "card", "evidence": {"ref": f"card:{cid}#merged/agent-07"}, "status": "verified",
                "correction": None, "reason": "the table says 12"},
               {"mark": 2, "kind": "card", "evidence": {"ref": f"card:{cid}#total/agent-07"}, "status": "verified",
                "correction": None, "reason": "a place that shows another value"},
               {"mark": 3, "kind": "card", "evidence": {"ref": f"card:{cid}#total/agent-07"}, "status": "verified",
                "correction": None, "reason": "the table says 40"}]
        return {"answer": _answer(out), "calls": [], "error": None}

    turn = marks.new_turn()
    main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}
    asyncio.run(marks.start_check(CORPUS, main, turn, ["Merged: [12](#) for agent-07."], "cut", fork=fork))
    assert f"in the takeaway of card:{cid} (Merged pull requests by agent): agent-07 merged [12] of" in seen[0]
    (chat,) = marks.stored(CORPUS, turn)["items"]
    assert chat["status"] == "verified" and chat["evidence"]["kind"] == "card"
    t = chat["evidence"]["table"]
    assert t["rows"][t["at"]["r"]]["label"] == "agent-07" and t["cols"][t["at"]["c"]] == "merged"
    kept = notebook.get_cell(CORPUS, cid)["takeaway_marks"]
    assert kept["text"] == "agent-07 merged [12](#) of [40](#) pull requests."
    first, second = kept["items"]
    assert first["k"] == 0 and first["status"] == "failed" and "shows 40" in first["reason"]
    assert second["k"] == 1 and second["status"] == "verified" and second["evidence"]["value"] == "40"
    # a takeaway checked once waits for no other check
    assert notebook.takeaways_to_check(CORPUS) == []


def _main_at(monkeypatch, cut: str | None):
    from types import SimpleNamespace

    lv = SimpleNamespace(sid=SID, cwd=str(config.corpus_dir(CORPUS)), config=None, config_known=False,
                         transcript_path=None, model="", effort="", context_tokens=0, last_cut=cut)
    monkeypatch.setattr(session, "current", lambda c: lv if c == CORPUS else None)


RUNS = {"text/html": "<table><thead><tr><th>run</th><th>issues closed</th><th>hours</th></tr></thead><tbody>"
                     "<tr><th>opus emergent</th><td>243</td><td>3.7</td></tr>"
                     "<tr><th>opus managed</th><td>104</td><td>2.5</td></tr></tbody></table>"}


def test_repair_checks_a_failed_mark_again_and_main_hears_how_it_ended(_fresh, monkeypatch):
    """Repair on a failed mark of a reply: it is checking again, a fork of main reads the checker's text with the
    terminal's repair request, and the validator decides; main hears of that one mark."""
    _seed_card("", [RUNS])
    cards = marks.session_cards(CORPUS)
    emergent, managed = (f"card:{cards[0]['id']}#issues%20closed/opus%20{s}" for s in ("emergent", "managed"))
    turn = marks.new_turn()
    failed = {"n": 1, "piece": 0, "k": 0, "words": "243 against 105", "sentence": "Opus closed [243 against 105] issues.",
              "status": "failed", "failedBy": "check", "reason": "The card shows 104, not 105.", "shown": "243 against 105"}
    marks._save(CORPUS, {"turn": turn, "items": [failed]})
    _main_at(monkeypatch, "cut-1")
    seen: list[str] = []

    async def fork(c, main, cut, prompt):
        seen.append(prompt)
        assert [m["status"] for m in marks.stored(CORPUS, turn)["items"]] == ["checking"]
        out = [{"mark": 1, "kind": "card", "evidence": [{"ref": emergent}, {"ref": managed}], "status": "corrected",
                "correction": {"words": "243 against 104"}, "reason": "the card shows 243 and 104"}]
        return {"answer": _answer(out), "calls": [], "error": None}

    async def go():
        assert await marks.repair(CORPUS, turn=turn, n=1, fork=fork) == ""
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))
        assert await marks.repair(CORPUS, turn=turn, n=1, fork=fork) == marks.NOT_FAILED

    asyncio.run(go())
    assert "The analyst pressed x to repair citation 1." in seen[0] and "found it wrong: \"The card shows 104" in seen[0]
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "corrected" and m["shown"] == "243 against 104" and m["was"] == "243 against 105", m
    (c, said), = [t for t in _fresh if not t[1].startswith("notice")]
    assert "pressed Repair" in said and '"243 against 105" is corrected to "243 against 104"' in said


def _wait_all():
    return asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))


def test_of_the_workspace_only_its_labels_definitions_are_evidence(_fresh, monkeypatch):
    """B11's folder is the labels' definitions alone: a reply's stored marks and main's chat, which hold the reply's own
    words, stay outside the folder this session works in, as a quote and as code, by their paths, by a path through
    the labels' folder, and through a link in it."""
    from app import concepts

    ws = config.workspace_dir(CORPUS)
    labels = concepts.concepts_dir(ws)
    labels.mkdir(parents=True, exist_ok=True)
    turn = marks.new_turn()
    stored = ws / "marks" / f"{turn}.json"
    (labels / "k9.json").symlink_to(stored)
    places = {1: ("quote", stored), 2: ("code", labels / ".." / "marks" / f"{turn}.json"),
              3: ("quote", agents.paths(CORPUS, agents.MAIN_ID)[1]), 4: ("code", labels / "k9.json")}

    async def fork(c, main, cut, text):
        def line(p: Path) -> int:
            lines = p.read_text(encoding="utf-8").splitlines()
            return next(i for i, x in enumerate(lines, 1) if "ask for a review" in x)

        n = [int(x) for x in re.findall(r"^(\d+)\. \[", text, re.M)]
        out = [{"mark": k, "kind": places[k][0], "status": "verified", "correction": None, "reason": "it says so",
                "evidence": {"file": str(places[k][1]), "line": line(places[k][1]), "substring": "ask for a review"}}
               for k in n]
        return {"answer": _answer(out), "calls": [], "error": None}

    _main_at(monkeypatch, "cut-1")
    reply = "Two posts [ask for a review](#), [ask for a review](#), [ask for a review](#) and [ask for a review](#)."

    async def go():
        main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}
        await marks.start_check(CORPUS, main, turn, [reply], "cut-1", fork=fork)
        await _wait_all()

    asyncio.run(go())
    items = marks.stored(CORPUS, turn)["items"]
    assert len(items) == 4
    for m in items:
        assert (m["status"], m["reason"]) == ("failed", OUTSIDE), m


def test_a_fork_that_started_without_its_prompt_runs_again(tmp_path, monkeypatch):
    """Claude Code waits 3 s for a prompt piped to it, then starts without it: the resumed fork stops with "No deferred
    tool marker found" (sdk.stdin_missed). The fork runs again, and its second run reads the prompt and answers."""
    monkeypatch.setattr(sdk, "STDIN_RETRY_WAIT_S", 0.0)
    bin_, runs = late_stdin_claude(tmp_path, misses=1)
    got = asyncio.run(marks._claude_fork([str(bin_)], tmp_path, {"PATH": "/usr/bin:/bin"}, "check the marks"))
    assert got["error"] is None and got["answer"] == "Read: check the marks", got
    assert len(runs.read_text().splitlines()) == 2


def test_a_fork_that_never_gets_its_prompt_stops_and_the_notice_says_why_whole(_fresh, tmp_path, monkeypatch):
    """A fork that starts without its prompt on every try (sdk.STDIN_TRIES) stops the check: its marks are unchecked
    with the whole error, which says in plain words that the prompt came too late and keeps Claude Code's own words, and
    the notice ends as a sentence does, with every word of the error in its text or its details (Show more)."""
    monkeypatch.setattr(sdk, "STDIN_RETRY_WAIT_S", 0.0)
    bin_, runs = late_stdin_claude(tmp_path, misses=99)
    shown: list[tuple[str, str | None]] = []
    monkeypatch.setattr(marks, "_notice", lambda c, text, details=None: shown.append((text, details)))

    async def fork(c, main, cut, prompt):
        return await marks._claude_fork([str(bin_)], tmp_path, {"PATH": "/usr/bin:/bin"}, prompt)

    turn = marks.new_turn()
    main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}

    async def go():
        await marks.start_check(CORPUS, main, turn, ["It says [ask for a review](#)."], "cut-1", fork=fork)
        await _wait_all()

    asyncio.run(go())
    assert len(runs.read_text().splitlines()) == sdk.STDIN_TRIES
    error = f"{sdk.STDIN_MISSED_TEXT}. Claude Code said: {NO_MARKER}"
    assert STDIN_WARNING not in error
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert (m["status"], m["reason"]) == ("unchecked", f"the check ended: {error}"), m
    ((text, details),) = shown
    assert text == marks.STOPPED_TEXT.format(why=sdk.STDIN_MISSED_TEXT), text
    assert details == marks.STOPPED_TEXT.format(why=error.rstrip(".")), details


def test_a_short_error_is_the_notice_s_whole_text(_fresh, monkeypatch):
    """An error that fits shows whole in the notice, which then has no details."""
    shown: list[tuple[str, str | None]] = []
    monkeypatch.setattr(marks, "_notice", lambda c, text, details=None: shown.append((text, details)))
    marks._stopped(CORPUS, "it took too long")
    assert shown == [("The check of the citations stopped (it took too long), so some are not checked. The next reply "
                      "is checked again.", None)]


def test_a_failed_fork_s_error_keeps_its_last_stderr_lines():
    """A fork that failed for another reason: its error is its stderr's last lines, whole, not only the last one."""
    said = marks.stderr_error(1, "\nTypeError: x is undefined\n    at run (cli.js:1:2)\n  at main (cli.js:3:4)\n\n")
    assert said == "TypeError: x is undefined at run (cli.js:1:2) at main (cli.js:3:4)"
    assert marks.stderr_error(2, "") == "Claude Code exited with code 2"
    assert marks.stderr_error(1, STDIN_WARNING) == sdk.STDIN_MISSED_TEXT
