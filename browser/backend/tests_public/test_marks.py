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
    """The mirror keeps main's texts of the turn; `done` names the turn, and the check gets those texts and the cut."""
    started: list[tuple] = []
    monkeypatch.setattr(marks, "turn_ended", lambda c, main, turn, texts, cut: started.append((turn, texts, cut, main["sid"])))
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
