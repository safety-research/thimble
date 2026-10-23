"""marks.py: the checks in the chat. Main cites claims as `[words](#)`; at the end of its turn a fork of it (the checker,
the terminal plugin's checker.md) proposes evidence for each, and the terminal's validator (plugin/engine/kernel/
evidence.py) decides what the analyst sees. The fork is replaced here; the marks, the validator and the records are
real."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, config, marks, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000aa"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    told: list[tuple[str, str]] = []
    monkeypatch.setattr(marks, "_tell", lambda c, text: told.append((c, text)))
    monkeypatch.setattr(marks, "_notice", lambda c, text: told.append((c, "notice: " + text)))
    yield told
    session._live.clear()


def _log() -> list[dict]:
    _, log_path = agents.paths(CORPUS, agents.MAIN_ID)
    return agents.read_events(log_path)


def _answer(items: list[dict]) -> str:
    return "Checked.\n```json\n" + json.dumps(items) + "\n```"


def test_the_checker_prompt_is_the_terminal_s_with_the_browser_s_few_changes():
    terminal = marks.CHECKER.read_text(encoding="utf-8")
    for old, _ in marks.CHECKER_CHANGES:
        assert old in terminal, f"the terminal's checker.md no longer says {old!r}: look at marks.CHECKER_CHANGES"
    text = marks.checker_prompt("1. [12] in: We saw [12] runs.", "/data")
    assert "1. [12] in: We saw [12] runs." in text and "{{" not in text and "thimble label" not in text


def test_split_marks_keeps_a_sentence_together_and_caps_the_forks():
    items = [{"n": i, "sentence": f"s{i // 2}"} for i in range(1, 41)]
    shares = marks.split_marks(items)
    assert len(shares) == marks.MAX_FORKS and sum(len(s) for s in shares) == 40
    assert [m["n"] for s in shares for m in s] == list(range(1, 41))
    assert marks.split_marks(items[:3]) == [items[:3]]


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


def test_a_fork_that_fails_leaves_its_marks_unchecked_and_says_so(_fresh):
    async def fork(c, main, cut, prompt):
        return {"error": "Claude Code exited with code 1"}

    turn = marks.new_turn()
    asyncio.run(marks.start_check(CORPUS, {"sid": SID}, turn, ["[3](#) runs"], "cut", fork=fork))
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "unchecked" and "exited" in m["reason"]
    assert any(t.startswith("notice") for _, t in _fresh)


def test_a_stopped_turn_s_marks_are_not_checked():
    turn = marks.new_turn()
    asyncio.run(marks.start_check(CORPUS, {"sid": SID}, turn, ["[3](#) runs"], None, fork=None))
    (m,) = marks.stored(CORPUS, turn)["items"]
    assert m["status"] == "unchecked"


def test_the_fork_s_stream_gives_its_answer_and_its_bash_calls():
    lines = [
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                                                       "input": {"command": "python3 - <<'PY'\nprint(1)\nPY"}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1",
                                                  "content": [{"type": "text", "text": "1\n"}]}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "```json\n[]\n```"}]}},
        {"type": "result", "subtype": "success", "result": "done"},
    ]
    got = marks.parse_stream("\n".join(json.dumps(x) for x in lines))
    assert got["error"] is None and got["answer"].startswith("```json")
    assert got["calls"] == [{"command": "python3 - <<'PY'\nprint(1)\nPY", "output": "1\n", "by": "checker"}]


def test_the_fork_resumes_main_at_the_turn_s_end_and_may_only_read_and_run_python():
    argv = marks.fork_argv({"sid": SID}, "cut-uuid", "claude-opus-5-5", "medium")
    assert argv[argv.index("--resume") + 1] == SID and argv[argv.index("--resume-session-at") + 1] == "cut-uuid"
    assert "--fork-session" in argv and "--no-session-persistence" in argv
    assert argv[argv.index("--tools") + 1] == "Read,Grep,Glob,Bash"
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert "Bash(python3:*)" in argv[argv.index("--allowedTools") + 1].split(",")


def test_main_s_turn_end_names_its_turn_and_starts_the_check(tmp_path, monkeypatch):
    """The mirror keeps main's texts of the turn; `done` names the turn, and the check gets those texts and the cut. The
    checks on Claude's answers get the same turn and texts (checks.answer_ended)."""
    from app import checks

    started: list[tuple] = []
    answered: list[dict] = []
    monkeypatch.setattr(marks, "turn_ended", lambda c, main, turn, texts, cut: started.append((turn, texts, cut, main["sid"])))
    monkeypatch.setattr(checks, "answer_ended", lambda c, turn: answered.append(turn))
    cwd = str(config.corpus_dir(CORPUS))
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, cwd, str(p))
    session.tail_once(lv)
    recs = [
        {"type": "user", "origin": {"kind": "human"}, "message": {"content": "How many runs failed?"}},
        {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5",
                                          "content": [{"type": "text", "text": "[3 of 8](#) runs failed."}]}},
        {"type": "system", "subtype": "turn_duration", "uuid": "u-cut"},
    ]
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)
    done = [r for r in _log() if r["type"] == "done"][-1]
    ((turn, texts, cut, sid),) = started
    assert done["turn"] == turn and texts == ["[3 of 8](#) runs failed."] and cut == "u-cut" and sid == SID
    assert answered == [{"sid": SID, "turn": turn, "rows": [{"uuid": "0", "text": "[3 of 8](#) runs failed."}]}]


def test_main_still_reads_the_check_s_notes_which_the_analyst_does_not_see():
    told = marks.tell_text([{"n": 1, "words": "41", "status": "verified", "note": "Runs did not only stop after noon."}])
    assert "The analyst does not see these" in told
    assert '- "Runs did not only stop after noon."' in told


TABLE = {"text/html": "<table><tr><th>agent</th><th>merged</th><th>total</th></tr>"
                      "<tr><th>agent-03</th><td>4</td><td>10</td></tr><tr><th>agent-07</th><td>12</td><td>40</td></tr></table>"}
PRINTED = {"text/plain": "          merged  total\nagent-03       4     10\nagent-07      12     40\n"}


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


def _verified(cid: str) -> list[dict]:
    return [{"mark": n, "kind": "card", "evidence": {"ref": f"card:{cid}#{col}/agent-07"}, "status": "verified",
             "correction": None, "reason": "the table says so"} for n, col in ((1, "merged"), (2, "total"))]


def test_a_card_s_takeaway_is_checked_as_its_write_lands_and_main_s_reply_leaves_it_alone(_fresh, monkeypatch):
    """A card written with cited words in its takeaway is checked right away, from main at its last finished turn, with
    no reply's record; main's reply that ends while that check runs does not check the takeaway again."""
    from app import notebook

    cid = _seed_card("agent-07 merged [12](#) of [40](#) pull requests.", [TABLE])
    _main_at(monkeypatch, "cut-1")
    forks: list[tuple[str, str]] = []

    async def go():
        gate = asyncio.Event()

        async def fork(c, main, cut, prompt):
            forks.append((cut, prompt))
            await gate.wait()
            return {"answer": _answer(_verified(cid)), "calls": [], "error": None}

        monkeypatch.setattr(marks, "run_fork", fork)
        marks.card_written(CORPUS, cid)
        await asyncio.sleep(0)  # the check took the takeaway
        for _ in range(200):  # its marks are on the card, checking
            if (notebook.get_cell(CORPUS, cid).get("takeaway_marks") or {}).get("items"):
                break
            await asyncio.sleep(0.02)
        assert [m["status"] for m in notebook.get_cell(CORPUS, cid)["takeaway_marks"]["items"]] == ["checking"] * 2
        # main's reply ends meanwhile, with no marks of its own: nothing is left for it to check
        main = {"sid": SID, "cwd": str(config.corpus_dir(CORPUS)), "transcript_path": None}
        await marks.start_check(CORPUS, main, marks.new_turn(), ["Done."], "cut-2", fork=fork)
        gate.set()
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))

    asyncio.run(go())
    assert len(forks) == 1 and forks[0][0] == "cut-1"
    assert f"in the takeaway of card:{cid} (Merged pull requests by agent)" in forks[0][1]
    kept = notebook.get_cell(CORPUS, cid)["takeaway_marks"]
    assert [m["status"] for m in kept["items"]] == ["verified", "verified"]
    assert not list((config.workspace_dir(CORPUS) / "marks").glob("*.json"))  # no reply's record
    assert notebook.takeaways_to_check(CORPUS) == []


def test_a_takeaway_waits_while_its_card_check_may_rewrite_it_or_main_has_no_turn_to_fork(_fresh, monkeypatch):
    from types import SimpleNamespace

    from app import card_check, notebook

    cid = _seed_card("agent-07 merged [12](#) of 40 pull requests.", [TABLE])
    started: list[str] = []
    monkeypatch.setattr(marks, "_spawn", lambda coro: (started.append("check"), coro.close()))
    monkeypatch.setattr(card_check, "_runs", {(CORPUS, cid): SimpleNamespace(task=SimpleNamespace(done=lambda: False))})
    _main_at(monkeypatch, "cut-1")
    marks.card_written(CORPUS, cid)
    assert started == []  # the card check's end calls card_written again
    monkeypatch.setattr(card_check, "_runs", {})
    monkeypatch.setenv("THIMBLE_RUNTIME", "off")
    _main_at(monkeypatch, None)
    marks.card_written(CORPUS, cid)
    assert started == []  # main's first turn has not ended: its end checks the takeaway
    _main_at(monkeypatch, "cut-1")
    marks.card_written(CORPUS, cid)
    assert started == ["check"]
    assert notebook.takeaways_to_check(CORPUS)  # nothing ran: the takeaway still waits


def test_a_printed_table_line_of_a_card_is_evidence_and_reads_as_a_table():
    cid = _seed_card("", [PRINTED])
    cards = marks.session_cards(CORPUS)
    ev = marks.evidence()
    r = ev.check_mark({"n": 1, "words": "12"}, {"kind": "card", "status": "verified", "evidence": {"ref": f"card:{cid}@out0#L3"}},
                      [], "/", cards=cards)
    assert r["status"] == "verified" and r["evidence"]["table"]["cols"] == ["merged", "total"]
    t = r["evidence"]["table"]
    assert t["rows"][t["at"]["r"]]["values"][t["at"]["c"]] == "12"


def test_a_marked_number_in_a_takeaway_is_left_for_the_check():
    from app import cite

    res = cite.resolve("abc12345", "agent-07 merged [12](#) pull requests", [TABLE])
    assert res.annotated == "agent-07 merged [12](#) pull requests" and not res.links
