"""A background session's news in its tray entry (bg_session, module note, the news): what a subagent's view would
show, read from the session's transcript in order, once, and soon."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app import bg_session, tools

CORPUS = "mini"
KEY = "writer:report"
THIMBLE = "mcp__plugin_thimble_thimble__"


@pytest.fixture()
def tx(tmp_path, monkeypatch):
    """A followed session whose transcript is a file this test appends records to."""
    path = tmp_path / "projects" / "-work" / "sid-1.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("")
    monkeypatch.setattr(bg_session.session, "find_transcript", lambda sid, config_dir=None: str(path) if sid == "sid-1" else None)
    monkeypatch.setattr(bg_session, "_closing", False)  # an earlier test's server shutdown sets it
    monkeypatch.setattr(bg_session, "_changed", asyncio.Event())
    e = bg_session.Entry(CORPUS, KEY, bg_session.name_of(CORPUS, KEY), "ab12cd34", "sid-1", "chat-1", "writer", "/work/report")
    bg_session._loaded.add(CORPUS)
    bg_session._entries[(CORPUS, KEY)] = e
    yield e, path
    bg_session._entries.pop((CORPUS, KEY), None)
    bg_session._loaded.discard(CORPUS)


def put(path: Path, *recs: dict, end: bool = True) -> None:
    with path.open("a") as f:
        f.write("\n".join(json.dumps(r) for r in recs) + ("\n" if end else ""))


def said(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def call(tid: str, name: str, **inp) -> dict:
    return {"type": "tool_use", "id": tid, "name": name, "input": inp}


def result(tid: str, content, is_error: bool = False) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": content, "is_error": is_error}]}}


def peer(body: str, **origin) -> dict:
    return {"type": "attachment", "uuid": f"u-{abs(hash(body))}", "attachment": {
        "type": "queued_command", "prompt": f"<agent-message from=\"a1\">\n{body}\n</agent-message>",
        "source_uuid": f"s-{abs(hash(body))}", "origin": {"kind": "peer", "from": "a1", "body": body, **origin}}}


def news(e) -> list[str]:
    bg_session._read_news(e)
    out, e.news = list(e.news), []
    return out


def test_each_tool_call_is_one_compact_line_naming_what_it_acts_on(tx):
    e, path = tx
    put(path, said(
        call("t1", "Bash", command="grep -c fail runs.jsonl\necho done", description="Count failures"),
        call("t2", "Read", file_path="/work/report/draft.md"),
        call("t3", "Grep", pattern="refund", path="/corpus/tickets"),
        call("t4", "Agent", subagent_type="general-purpose", description="Check the numbers", prompt="…" * 500),
        call("t5", "Skill", skill="thimble:shared"),
        call("t6", f"{THIMBLE}add_card", question="Which tasks fail most?", code="x" * 5000),
        call("t7", f"{THIMBLE}edit_card", card="card:abc123", takeaway="…"),
        call("t8", f"{THIMBLE}write_document", doc="report", text="# A long report\n" * 400),
        call("t9", "mcp__claude-in-chrome__navigate", url="https://example.org"),
        call("t10", "ToolSearch", query="select:Monitor"),
        call("t11", "Workflow", script="export const meta = {name: 'audit', description: 'Audit the runs'}\n…"),
        call("t12", "Write", file_path="/elsewhere/" + "d/" * 200 + "x.md", content="…"),
    ))
    lines = news(e)
    assert lines[:11] == [
        "● Bash: grep -c fail runs.jsonl",
        "● Read: draft.md",
        "● Grep: refund in /corpus/tickets",
        "● Agent: general-purpose · Check the numbers",
        "● Skill: thimble:shared",
        "● add_card: Which tasks fail most?",
        "● edit_card: card:abc123",
        "● write_document: report",
        "● claude-in-chrome:navigate: https://example.org",
        "● Workflow: Audit the runs",
        lines[10],
    ], "ToolSearch is Claude Code's plumbing and shows no line"
    assert lines[10].startswith("● Write: /elsewhere/d/") and lines[10].endswith("…")
    assert len(lines[10]) <= len("● Write: ") + bg_session.TOOL_CHARS
    assert len(lines) == 11


def test_a_call_that_names_only_its_card_shows_the_card_s_question(tx, monkeypatch):
    e, path = tx
    from app import notebook
    monkeypatch.setattr(notebook, "find_cell", lambda ws, cid: ("g1", {"id": cid, "title": "Why do runs stall?"})
                        if cid == "abc123" else None)
    put(path, said(call("e1", f"{THIMBLE}edit_card", card="card:abc123", takeaway="…"),
                   call("e2", f"{THIMBLE}edit_card", card="card:gone", takeaway="…")))
    assert news(e) == ["● edit_card: Why do runs stall?", "● edit_card: card:gone"]


def test_a_failed_result_is_marked_with_its_tool_and_the_error_s_first_line_and_a_good_one_shows_nothing(tx):
    e, path = tx
    put(path, said(call("b1", "Bash", command="false"), call("m1", f"{THIMBLE}add_card", question="Q")),
        result("b1", "<tool_use_error>Exit code 1\nstderr: nope</tool_use_error>", is_error=True),
        result("m1", [{"type": "text", "text": "Added [[card:x1]]"}]))
    put(path, said(call("r1", "Read", file_path="/nope")), result("r1", [{"type": "text", "text": "\nFile does not exist."}], True))
    assert news(e) == ["● Bash: false", "● add_card: Q", "✗ Bash: Exit code 1", "● Read: /nope", "✗ Read: File does not exist."]


def test_messages_name_their_sender_and_recipient_in_both_directions(tx):
    e, path = tx
    e.prompts = [bg_session._norm("Write the report on refunds.")]  # as start() keeps the prompt it started it with
    typed = tools.hint("bg-from-terminal", text="Shorter, please.")
    browser = tools.hint("bg-from-browser", text="Add the 2025 numbers.")
    from_main = tools.hint("bg-from-main", text="The critic is done.")
    put(path,
        {"type": "user", "uuid": "p0", "origin": {"kind": "human"}, "promptSource": "typed",
         "message": {"role": "user", "content": "Write the report on refunds."}},
        {"type": "user", "isMeta": True, "message": {"role": "user", "content": "<system-reminder>x</system-reminder>"}},
        {"type": "system", "subtype": "turn_duration", "durationMs": 5},
        peer(typed), peer(browser), peer(from_main),
        peer("Found 3 problems.", name="thimble:critic"),
        peer("[Subagent hand-back] The text below is the final report. The report follows:\n  12 runs fail.\n  3 tasks.",
             handback=True, name="general-purpose"),
        said(call("s1", "SendMessage", to="main", message="Draft ready.\nSee the report.")),
        {"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "Stop after this section."}},
        {"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": tools.hint(
            "bg-first-message", path="/work/report/.thimble-first-message.md")}},
        {"type": "attachment", "attachment": {"type": "queued_command", "commandMode": "task-notification", "prompt":
            "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"sleep\" completed</summary>\n</task-notification>"}})
    assert news(e) == [
        "✉ thimble → thimble:writer: Write the report on refunds.",
        "✉ analyst (tray) → thimble:writer: Shorter, please.",
        "✉ analyst (browser) → thimble:writer: Add the 2025 numbers.",
        "✉ main → thimble:writer: The critic is done.",
        "✉ thimble:critic → thimble:writer: Found 3 problems.",
        "✉ general-purpose (hand-back) → thimble:writer: 12 runs fail. 3 tasks.",
        "✉ thimble:writer → main: Draft ready. See the report.",
        "✉ analyst (attached) → thimble:writer: Stop after this section.",
        "✉ thimble → thimble:writer: Your first message is in /work/report/.thimble-first-message.md. Read it whole and follow it.",
        '✉ background task → thimble:writer: Background command "sleep" completed',
    ]


def test_a_message_claude_code_writes_in_two_shapes_shows_once(tx):
    e, path = tx
    body = tools.hint("bg-from-terminal", text="Go on.")
    queued = peer(body)
    prompt = {"type": "user", "isMeta": True, "uuid": queued["attachment"]["source_uuid"], "origin": queued["attachment"]["origin"],
              "message": {"role": "user", "content": queued["attachment"]["prompt"]}}
    put(path, queued, prompt)
    assert news(e) == ["✉ analyst (tray) → thimble:writer: Go on."]
    again = peer(body)
    again["attachment"]["source_uuid"] = "s-again"
    put(path, said({"type": "text", "text": "Going on."}), again)
    assert news(e) == ["thimble:writer: Going on.", "✉ analyst (tray) → thimble:writer: Go on."], \
        "the same words sent again later are a new message"


def test_the_cursor_keeps_the_transcript_s_order_and_never_repeats_a_line(tx):
    e, path = tx
    put(path, said({"type": "text", "text": "One."}, call("a", "Bash", command="ls")))
    assert news(e) == ["thimble:writer: One.", "● Bash: ls"]
    assert news(e) == []
    put(path, said({"type": "text", "text": "Two."}))
    put(path, said(call("b", "Bash", command="pwd")), end=False)  # Claude Code is still writing this line
    assert news(e) == ["thimble:writer: Two."]
    with path.open("a") as f:
        f.write("\n")
    put(path, said({"type": "text", "text": "Three."}))
    assert news(e) == ["● Bash: pwd", "thimble:writer: Three."]
    assert news(e) == []


def test_a_normal_reply_shows_whole_and_a_long_one_keeps_its_start_and_says_how_much_was_cut(tx):
    e, path = tx
    normal = "## Summary\n\n" + "The refunds rose in March. " * 60
    long = "x" * (bg_session.NEWS_CHARS + 1234)
    put(path, said({"type": "text", "text": normal}), said({"type": "text", "text": long}))
    first, second = news(e)
    assert first == f"thimble:writer: {normal.strip()}"
    assert second.startswith("thimble:writer: " + "x" * bg_session.NEWS_CHARS)
    assert "1,234 more characters" in second and "claude attach ab12cd34" in second
    assert e.last_said == long


async def test_wait_session_returns_the_lines_as_one_block_soon_after_they_are_written_and_once(tx, monkeypatch):
    e, path = tx
    monkeypatch.setattr(bg_session, "WAIT_S", 5.0)
    monkeypatch.setattr(bg_session, "NEWS_POLL_S", 0.05)
    monkeypatch.setattr(bg_session, "NEWS_GATHER_S", 0.05)

    async def later() -> None:
        await asyncio.sleep(0.2)
        put(path, said(call("a", "Bash", command="ls"), {"type": "text", "text": "Listed."}))

    t0 = time.monotonic()
    task = asyncio.create_task(later())
    got = await bg_session.wait(CORPUS, "thimble:writer")
    await task
    assert time.monotonic() - t0 < 2.0, "a waiting wait_session reads the transcript itself, not only on the watcher's pass"
    block = got.split("\n\n")[0]
    assert block == "● Bash: ls\nthimble:writer: Listed."
    assert tools.hint("wait_session-copy") in got
    monkeypatch.setattr(bg_session, "WAIT_S", 0.2)
    again = await bg_session.wait(CORPUS, "thimble:writer")
    assert "● Bash: ls" not in again and tools.hint("wait_session-quiet", session=e.name, state="working") in again


async def test_news_no_entry_took_waits_only_so_long_and_the_next_wait_says_how_much_was_dropped(tx, monkeypatch):
    e, _path = tx
    monkeypatch.setattr(bg_session, "NEWS_KEEP", 3)
    monkeypatch.setattr(bg_session, "NEWS_GATHER_S", 0.0)
    for i in range(5):
        bg_session._news(e, f"line {i}")
    got = await bg_session.wait(CORPUS, "thimble:writer")
    assert got.split("\n\n")[0] == "… 2 earlier lines are not shown; `claude attach ab12cd34` shows them\nline 2\nline 3\nline 4"
    assert e.dropped == 0


def test_a_repeat_after_a_message_in_two_shapes_shows_again_in_either_shape(tx):
    e, path = tx
    typed = {"kind": "human"}
    queued = {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "stop now", "source_uuid": "q1",
                                                   "origin": typed}}
    prompt = {"type": "user", "uuid": "q1", "origin": typed, "message": {"role": "user", "content": "stop now"}}
    put(path, queued, prompt)
    assert news(e) == ["✉ analyst (attached) → thimble:writer: stop now"]
    put(path, {"type": "user", "uuid": "p2", "origin": typed, "message": {"role": "user", "content": "stop now"}})
    assert news(e) == ["✉ analyst (attached) → thimble:writer: stop now"], "typed again while idle: a new message"
    put(path, {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "stop now", "source_uuid": "q3",
                                                    "origin": typed}})
    assert news(e) == ["✉ analyst (attached) → thimble:writer: stop now"]


def test_main_s_message_and_an_interrupt_show_as_what_they_are(tx):
    e, path = tx
    put(path,
        {"type": "attachment", "attachment": {"type": "queued_command", "source_uuid": "c1", "origin": {"kind": "coordinator"},
                                              "prompt": "main sent a message while you were working:\nWrap up.\n\nAddress this soon."}},
        {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}},
        said({"type": "text", "text": "Stopped."}))
    assert news(e) == ["✉ main → thimble:writer: Wrap up.", "thimble:writer was interrupted.", "thimble:writer: Stopped."]


def test_a_line_that_cannot_be_read_is_skipped_and_the_rest_still_shows(tx, monkeypatch):
    e, path = tx
    real = bg_session._news_lines

    def flaky(e, line):
        if b"boom" in line:
            raise AttributeError("boom")
        return real(e, line)

    monkeypatch.setattr(bg_session, "_news_lines", flaky)
    put(path, said({"type": "text", "text": "boom"}), said({"type": "text", "text": "After."}))
    assert news(e) == ["thimble:writer: After."]


def test_a_new_session_s_news_starts_at_its_transcript_s_start(tx, monkeypatch):
    e, path = tx
    bg_session._entries.pop((CORPUS, KEY), None)
    monkeypatch.setattr(bg_session, "_ensure_watcher", lambda: None)
    monkeypatch.setattr(bg_session, "_save", lambda c: None)
    put(path, {"type": "user", "uuid": "p0", "origin": {"kind": "human"},
               "message": {"role": "user", "content": "Write the report."}},
        said(call("a", "Bash", command="ls")))
    fresh = bg_session.record(CORPUS, KEY, short="ab12cd34", sid="sid-1", chat="chat-1", role="writer",
                              folder=Path("/work/report"), offset=0)
    fresh.prompts = [bg_session._norm("Write the report.")]
    assert news(fresh) == ["✉ thimble → thimble:writer: Write the report.", "● Bash: ls"]


async def test_one_wait_session_answer_is_capped_and_the_rest_comes_with_the_next(tx, monkeypatch):
    e, _path = tx
    monkeypatch.setattr(bg_session, "NEWS_GATHER_S", 0.0)
    lines = [f"thimble:writer: {i} " + "x" * 3_000 for i in range(200)]
    for line in lines:
        bg_session._news(e, line)
    got: list[str] = []
    for _ in range(200):
        block = (await bg_session.wait(CORPUS, "thimble:writer")).split("\n\n")[0]
        assert len(block) <= bg_session.NEWS_RETURN_CHARS
        got.extend(block.split("\n"))
        if not e.news:
            break
    assert got == lines
