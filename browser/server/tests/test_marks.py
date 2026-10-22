"""Marks: a reply's marks are checked by copies of the chat, each with a share, and the terminal's validator decides what
the analyst sees: computed evidence holds only when one of the conversation's real run_python calls printed the
output the check cites, and that output shows the words. A correction is told to main with the analyst's next message; a check that fails leaves no mark checking."""
import asyncio
import json
import shutil

import pytest

from thimble_browser import agent, chats, home, llm
from thimble_browser.features import marks

from fakes import ScriptedClient

node = pytest.mark.skipif(shutil.which("node") is None, reason="the marks are read with the terminal's message.js")


def test_the_marks_split_into_shares_that_keep_a_sentence_together():
    items = [{"n": i, "sentence": f"s{i // 3}"} for i in range(1, 13)]
    shares = marks.split_marks(items)
    assert len(shares) == 3 and sum(shares, []) == items  # up to 4 marks a share, in order
    for sentence in {m["sentence"] for m in items}:
        assert sum(any(m["sentence"] == sentence for m in s) for s in shares) == 1
    assert len(marks.split_marks(items[:4])) == 1


def test_main_reads_corrections_and_notes_and_nothing_when_all_held():
    held = [{"n": 1, "words": "12", "status": "verified", "shown": "12"}]
    assert marks.tell_text(held) == ""
    text = marks.tell_text([{"n": 1, "words": "15", "status": "corrected", "shown": "12", "was": "15", "reason": "12 merged"},
                            {"n": 2, "words": "all", "status": "failed", "failedBy": "evidence", "shown": "all",
                             "note": "Not the only one: b also failed."}])
    assert '"15" is corrected to "12" (the check: "12 merged")' in text
    assert '"all" is flagged as not confirmed' in text and "Not the only one: b also failed." in text


def test_a_run_python_call_reads_as_the_terminals_one_python_script():
    msgs = [{"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "run_python", "input": {"code": "print(12)"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "12"}]}]
    assert marks.run_python_calls(msgs, "main") == [{"command": "python3 - <<'PY'\nprint(12)\nPY", "output": "12", "by": "main"}]


CODE = "rows = open('results.csv').read().splitlines()[1:]\nprint(f\"{sum(r.endswith('merged') for r in rows)} of {len(rows)} runs merged\")"


def checker(answer):
    def script(req):
        last = req["messages"][-1]["content"]
        if isinstance(last, str) and "check your last reply" in last:
            return [{"tool": "run_python", "input": {"code": CODE}}]
        return ["```json\n" + json.dumps(answer) + "\n```"]
    return script


async def checked(folder, monkeypatch, answer, reply="[2 of 2](#) runs merged.", output="1 of 2 runs merged"):
    ws = home.open_folder(folder)
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script=checker(answer)))
    agent.save_messages(ws, "main", [{"role": "user", "content": "How many merged?"},
                                     {"role": "assistant", "content": [{"type": "text", "text": reply}]}])
    sessions = agent.Sessions(unsandboxed=True)

    async def run_python(t, args):  # what the sandbox would print
        from thimble_browser.tools import Result
        return Result(output)
    monkeypatch.setattr(agent.Tools, "t_run_python", run_python, raising=False)
    await marks.start_check(sessions, ws, "main", "abcd1234", [reply], None)
    for _ in range(200):
        items = marks.reply_items(ws, "main", "abcd1234")
        if items and all(m["status"] != "checking" for m in items):
            return ws, items
        await asyncio.sleep(0.02)
    raise AssertionError(items)


ANSWER = [{"mark": 1, "words": "2 of 2", "kind": "computed",
           "evidence": {"output": "1 of 2 runs merged"},
           "status": "corrected", "correction": {"words": "1 of 2", "was": "2 of 2"}, "reason": "one run merged"}]


@node
async def test_a_correction_shows_the_calls_real_output_and_main_hears_it(folder, monkeypatch):
    ws, items = await checked(folder, monkeypatch, ANSWER)
    assert [(m["status"], m["shown"], m.get("was")) for m in items] == [("corrected", "1 of 2", "2 of 2")]
    assert items[0]["evidence"]["output"] == "1 of 2 runs merged" and items[0]["evidence"]["by"] == "checker"
    assert '"2 of 2" is corrected to "1 of 2"' in agent.take_notes(ws, "main")[0]
    # the checker is a copy the thread list does not show
    assert [m["id"] for m in chats.listing(ws, set())] == ["main"]


@node
async def test_evidence_no_call_printed_does_not_confirm_the_mark(folder, monkeypatch):
    ws, items = await checked(folder, monkeypatch, ANSWER, output="nothing like it")
    assert items[0]["status"] == "failed" and items[0]["failedBy"] == "evidence"
    assert items[0]["reason"].startswith("Not confirmed:")


@node
async def test_an_answer_with_no_json_leaves_the_marks_unchecked_and_says_so(folder, monkeypatch):
    ws = home.open_folder(folder)
    monkeypatch.setattr(llm, "client", lambda: ScriptedClient(script=lambda req: ["I could not check it."]))
    agent.save_messages(ws, "main", [{"role": "user", "content": "q"}, {"role": "assistant", "content": [{"type": "text", "text": "[3](#) runs."}]}])
    await marks.start_check(agent.Sessions(unsandboxed=True), ws, "main", "abcd1235", ["[3](#) runs."], None)
    for _ in range(200):
        items = marks.reply_items(ws, "main", "abcd1235")
        if items and items[0]["status"] != "checking":
            break
        await asyncio.sleep(0.02)
    assert items[0]["status"] == "unchecked"
    notices = [r for r in chats.records(ws, "main") if r["type"] == "notice"]
    assert notices and "gave no answer thimble could read" in notices[-1]["text"]
