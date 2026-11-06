"""session.py: the mirror of the analyst's Claude Code session. The transcript tail translates a turn and skips every
other record, and main follows its session when Claude Code moves it into a background job. Every transcript here is
written by the test in Claude Code's record shapes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, cc_plugin, config, events, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-000000000001"
ADD_CARD = "mcp__plugin_thimble_thimble__add_card"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    # Claude Code's config dir, empty: the mirror reads a session's state file from it (session.session_state)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    session._expected.clear()
    session._event_threads.clear()
    for table in (events._subs, events._pending, events._taken):
        table.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    for table in (events._subs, events._pending, events._taken):
        table.clear()


@pytest.fixture()
def cwd() -> str:
    return str(config.corpus_dir(CORPUS))


def _log(chat: str) -> list[dict]:
    _, log_path = agents.paths(CORPUS, chat)
    return agents.read_events(log_path)


def _mirror() -> list[dict]:
    return [r for r in _log(agents.MAIN_ID) if r.get("by") in ("terminal", "browser")]


def _attach(cwd: str, transcript: Path, sid: str = SID, **kw) -> session.Live:
    lv = session.attach(CORPUS, sid, cwd, str(transcript), **kw)
    assert lv is not None
    return lv


END = {"type": "system", "subtype": "turn_duration"}


def _human(text: str) -> dict:
    return {"type": "user", "origin": {"kind": "human"}, "message": {"content": text}}


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": list(blocks)}}


def _say(text: str) -> dict:
    return {"type": "text", "text": text}


def _use(tool_use_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _result(tool_use_id: str, content) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]}}


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


# ----------------------------------------------------------------------------- the tail


def test_the_tail_translates_a_turn_and_skips_every_other_record(cwd, tmp_path):
    """A turn of main's: the prompt is the analyst's line, then the add_card call with the card id read from its result,
    the reply, and `done` at the turn's end. The ToolSearch that loaded add_card, attachments, thinking, meta prompts and
    queue records write nothing."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [
        _human("Add a card that counts the board's posts."),
        {"type": "attachment", "attachment": {"type": "environment"}},
        {"type": "queue-operation", "operation": "enqueue"},
        _assistant({"type": "thinking", "thinking": ""}),
        _assistant(_use("toolu_ts", "ToolSearch", {"query": "select:" + ADD_CARD})),
        _result("toolu_ts", "loaded"),
        _assistant(_use("toolu_ac", ADD_CARD, {"kind": "code", "question": "How many posts?", "code": "print(8)"})),
        _result("toolu_ac", '$ add_card kind="code" question="How many posts?" code="print(8)"\ncard:cd34ef56\nL1|8'),
        {"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "Base directory"}]}},
        _assistant(_say("card:cd34ef56")),
        END,
    ])
    recs = _mirror()
    assert [r["type"] for r in recs] == ["user", "tool_use", "tool_result", "text", "done"], recs
    user, use, made, text, _ = recs
    assert user["text"] == "Add a card that counts the board's posts." and user["by"] == "terminal"
    assert use["name"] == ADD_CARD and made["cell_id"] == "cd34ef56" and text["delta"] == "card:cd34ef56"
    assert not lv.degraded and lv.offset == p.stat().st_size and lv.buf == b""
    n = len(_log(agents.MAIN_ID))
    session.tail_once(lv)
    assert len(_log(agents.MAIN_ID)) == n  # nothing new


# ----------------------------------------------------------------------------- a session that continues in a job


def _subscribe(sid: str, delivery: str = cc_plugin.HOOK) -> events.Sub:
    sub = events.Sub(sid, delivery)
    events._subs.setdefault(CORPUS, set()).add(sub)
    return sub


def _write(p: Path, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


@pytest.fixture()
def project(tmp_path) -> Path:
    """The project folder of Claude Code's config dir, where find_transcript finds the job's transcript."""
    d = tmp_path / "claude-config" / "projects" / "-corpus"
    d.mkdir(parents=True)
    return d


@pytest.fixture()
def quits(monkeypatch) -> list[str]:
    """The workspaces whose agents stopped because main's session ended (session._stop_agents)."""
    stopped: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", stopped.append)
    monkeypatch.setattr(session, "_shutting_down", lambda: False)
    monkeypatch.setattr(session, "GRACE_S", 0)
    return stopped


def test_a_message_the_analyst_pasted_is_theirs_in_the_context_and_claude_code_s_own_records_are_not(tmp_path):
    """Claude Code 2.1.300 writes a message the analyst pasted as a prompt whose text starts with its
    `<pasted_content id="…">` tag, which the context took for one of Claude Code's own records and left out, so a
    writer, a check, the critic and the card check never read it. The context's conversation now shows a paste as the
    analyst's message, the pasted text indented under a `(pasted)` line among what they typed around it, typed or
    queued, and still leaves out every record that starts with another tag."""
    from app import context

    def human(content: str | list) -> dict:
        return {"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": content}}

    def paste(text: str, pid: str = "3f9a") -> str:
        return f'<pasted_content id="{pid}">\n{text}\n</pasted_content id="{pid}">\n'

    path = tmp_path / f"{SID}.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in [
        human(paste("ERROR 1\n  at step 2\n\nERROR 3")),
        human("why does it fail here?\n\n" + paste("Traceback (most recent call last)", "07c1") + "\nand here?\n\n"
              + paste("KeyError: 'posts'", "07c1")),
        {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": paste("in a text block")}]}},
        {"type": "attachment", "attachment": {"type": "queued_command", "prompt": paste("sent while it worked", "5d6e")}},
        human("<command-name>/model</command-name>\n<command-args>opus</command-args>"),
        human("<local-command-stdout>Set model to opus</local-command-stdout>"),
        human("<bash-input>ls runs</bash-input>"),
        human("<bash-stdout>a.jsonl</bash-stdout><bash-stderr></bash-stderr>"),
        human("<user-memory-input>keep runs short</user-memory-input>"),
        human("<system-reminder>\nnot the analyst's\n</system-reminder>"),
        human('<pasted_content id="nothex">\nno paste of Claude Code\'s\n</pasted_content id="nothex">'),
        human("[Request interrupted by user]"),
        human("  typed, as before  "),
    ]) + "\n")
    said = [(e.head, e.body) for e in context._entries(path)]
    assert said == [
        ("[analyst]", "(pasted)\n    ERROR 1\n      at step 2\n\n    ERROR 3"),
        ("[analyst]", "why does it fail here?\n(pasted)\n    Traceback (most recent call last)\nand here?\n"
                      "(pasted)\n    KeyError: 'posts'"),
        ("[analyst]", "(pasted)\n    in a text block"),
        ("[analyst]", "(pasted)\n    sent while it worked"),
        ("[analyst]", "/model opus"),
        ("[analyst]", "typed, as before"),
    ]


def test_a_paste_that_quotes_a_command_s_record_stays_the_analyst_s_message(tmp_path):
    """An analyst of agents' transcripts may paste a record of one, which can hold Claude Code's `<command-name>` tag.
    The context took any prompt with that tag for a command and showed only its name, so the paste and the words typed
    with it were lost. A command is now read from what the analyst typed alone; Claude Code's own record of a command
    still reads as its command line."""
    from app import context

    def human(content: str) -> dict:
        return {"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": content}}

    record = json.dumps({"type": "user", "message": {"content": "<command-name>/clear</command-name>\n<command-args>"
                                                                "</command-args>"}})
    pasted = f'\n\n<pasted_content id="a1b2">\n{record}\n</pasted_content id="a1b2">\n'
    path = tmp_path / f"{SID}.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in [
        human(pasted),
        human("why did this run clear its context?" + pasted),
        human("<command-name>/model</command-name>\n<command-args>opus</command-args>"),
    ]) + "\n")
    assert [(e.head, e.body) for e in context._entries(path)] == [
        ("[analyst]", f"(pasted)\n    {record}"),
        ("[analyst]", f"why did this run clear its context?\n(pasted)\n    {record}"),
        ("[analyst]", "/model opus"),
    ]


# ----------------------------------------------------------------------------- a thread's fork linked to its thread


def test_a_forks_closing_note_as_the_answer_drops_what_it_made_and_starts_with_a_capital():
    """Live check term-fix6, new quirk 3: the `↳` fallback answer read `added a table card. Yes, 23 June…`."""
    assert session.note_answer("added a table card. Yes, 23 June still has the most deletions (473).") == \
        "Yes, 23 June still has the most deletions (473)."
    assert session.note_answer("added a table card of the 25 deletions from 18:00 to 19:00 UTC on 18 June. WikiKeeper "
                               "made all of them.") == "WikiKeeper made all of them."
    assert session.note_answer("I added a table of the deletions per minute and answered in the thread. The 18:21 "
                               "deletion is the first of 25.") == "The 18:21 deletion is the first of 25."
    # a note that is only the clause, or holds none, keeps its words
    assert session.note_answer("added a table card.") == "Added a table card."
    assert session.note_answer("the count went from 2.5 to 3. Then it fell.") == "The count went from 2.5 to 3. Then it fell."
