"""session.py: the mirror of the analyst's Claude Code session. The transcript tail translates a turn and skips every
other record, and main follows its session when Claude Code moves it into a background job. Every transcript here is
written by the test in Claude Code's record shapes."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, cc_plugin, config, events, session, threads

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
    session._came_back.clear()
    session._shim_pids.clear()
    session._shim_configs.clear()
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


# ----------------------------------------------------------------------------- a thread's fork called twice


def test_a_fork_that_ends_with_its_session_may_be_forked_again_at_once(cwd, monkeypatch):
    """--continue resumes main under the same session id: the fork the ended session ran is gone, so a new Agent call
    for the thread is not refused as a second fork (subagents.json `forking` loses the thread)."""
    from app import subagent_files as files
    from app import subagents

    monkeypatch.setattr(files, "terminal", lambda ws: True)
    thread = agents.new_thread(CORPUS, None, None, "Days")
    tid = thread["id"]
    agents.update_agent(CORPUS, tid, **{threads.FORK_NAME_KEY: "which-days"})
    with subagents.update(CORPUS) as state:
        assert files.fork_check(state, {"subagent_type": "fork", "description": "thread:which-days", "prompt": "thread:which-days"}) is None
    threads.fork_started(CORPUS, tid, agent_id="a1", tool_use_id="toolu_f1", session=SID)
    threads.session_ended(CORPUS, SID)
    with subagents.update(CORPUS) as state:
        assert files.fork_check(state, {"subagent_type": "fork", "description": "thread:which-days", "prompt": "thread:which-days"}) is None


# ----------------------------------------------------------------------------- a thread's fork linked to its thread


QUESTION = "On which days did the page change?"


def _fork_files(project: Path, agent: str, tool_use_id: str, name: str | None, call: dict | None) -> Path:
    """A thread's fork's transcript and meta json as Claude Code writes them in terminal mode: the meta's description is
    the thread's question, which thimble-term gave the call (live check term-fix5, new quirk 1), with `name` only when
    main passed one; the file holds its copy of the call (`call`) when one is given."""
    d = project / SID / "subagents"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"agent-{agent}.jsonl"
    meta = {"agentType": "fork", "isFork": True, "description": f"thread: {QUESTION}",
            "toolUseId": tool_use_id, **({"name": name} if name else {})}
    path.with_name(f"agent-{agent}.meta.json").write_text(json.dumps(meta))
    recs: list[dict] = [{"type": "fork-context-ref", "agentId": agent, "parentSessionId": SID}]
    if call is not None:
        recs.append({"type": "assistant", "isSidechain": True, "agentId": agent, "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": tool_use_id, "name": "Agent", "input": call}]}})
    _write(path, recs)
    return path


def _fork_works(path: Path, agent: str) -> None:
    _write(path, [
        {"type": "assistant", "isSidechain": True, "agentId": agent, "message": {"role": "assistant", "content": [
            _use("toolu_wc", "Bash", {"command": "wc -l pages.jsonl"})]}},
        {"isSidechain": True, "agentId": agent, "type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_wc", "content": "500 pages.jsonl"}]}},
        {"type": "assistant", "isSidechain": True, "agentId": agent, "message": {"role": "assistant", "content": [
            _say("It changed on 16 and 18 June.")]}},
    ])


@pytest.mark.parametrize("named", [True, False], ids=["name", "no-name"])
@pytest.mark.parametrize("first", ["file", "tool_use"])
@pytest.mark.parametrize("known_by", ["hook", "file-call", "tool_use"])
def test_a_thread_s_fork_joins_its_thread_whatever_main_passes_and_whichever_comes_first(cwd, project, quits, named,
                                                                                         first, known_by):
    """Live check term-fix5, new quirk 1: main passed no `name`, so the fork's meta json named the thread only by its
    question (thimble-term's description), the mirror saw the file before main's tool_use, made a plain agent chat, and
    the thread never got its fork. Now the fork joins its thread in either order, with or without a name: by the
    agent-check hook's record of the call (`hook`), by the call the fork's own file holds (`file-call`), or, with
    neither, by main's tool_use, which turns a plain agent chat made first into the thread's (`tool_use`). The fork's
    steps and answer show in the thread, no agent chat is left in main, and its end finishes the thread."""
    from app import subagent_files as files
    from app import subagents

    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_plugin.HOOK)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    thread = agents.new_thread(CORPUS, None, None, "Days the page changed")
    tid = thread["id"]
    events.post(CORPUS, "thread", {"thread": tid, "text": QUESTION})
    name = agents.read_meta(CORPUS, tid)[threads.FORK_NAME_KEY]
    call = {"subagent_type": "fork", "description": f"thread:{name}", "prompt": f"thread:{name}",
            **({"name": name} if named else {})}
    if known_by == "hook":  # what the agent-check hook saw: thimble-term's description, the prompt main wrote
        with subagents.update(CORPUS) as state:
            assert files.fork_check(state, {**call, "description": f"thread: {QUESTION}"}, None,
                                    "toolu_f1") is None
    file_call = call if known_by == "file-call" else None
    named_meta = name if named else None
    tool_use = [_human("Look into the thread"), _assistant(_use("toolu_f1", "Agent", call)),
                _result("toolu_f1", "Async agent launched successfully.\nagentId: f0e1d2c3")]
    if first == "file":
        path = _fork_files(project, "f0e1d2c3", "toolu_f1", named_meta, file_call)
        _fork_works(path, "f0e1d2c3")
        session._scan_subs(lv)
        session.tail_once(lv)
        _append(p, lv, tool_use)
    else:
        _append(p, lv, tool_use)
        path = _fork_files(project, "f0e1d2c3", "toolu_f1", named_meta, file_call)
        _fork_works(path, "f0e1d2c3")
        session._scan_subs(lv)
    session.tail_once(lv)
    fork = agents.read_meta(CORPUS, tid)["fork"]
    assert fork["agent_id"] == "f0e1d2c3" and fork["tool_use_id"] == "toolu_f1" and fork["session"] == SID
    assert not [m for m in agents.list_chats(CORPUS) if m.get("role") == session.SUBAGENT_ROLE], \
        "no agent chat in main for the thread's fork"
    log = _log(tid)
    assert [r["name"] for r in log if r["type"] == "tool_use"] == ["Bash"], "the fork's steps show in the thread"
    assert [r["delta"] for r in log if r["type"] == "text" and r.get("reply")] == ["It changed on 16 and 18 June."]
    assert agents.running(CORPUS, tid)
    note = ("<task-notification>\n<task-id>f0e1d2c3</task-id>\n<tool-use-id>toolu_f1</tool-use-id>\n"
            "<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>")
    _append(p, lv, [END, {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("The thread is answered.")), END])
    assert not agents.running(CORPUS, tid)
    assert [r["type"] for r in _log(tid) if r["type"] in ("done", "error")] == ["done"]


def test_a_forks_closing_note_as_the_answer_drops_what_it_made_and_starts_with_a_capital():
    """Live check term-fix6, new quirk 3: the `↳` fallback answer read `added a table card. Yes, 23 June…`."""
    assert session.note_answer("added a table card. Yes, 23 June still has the most deletions (473).") == \
        "Yes, 23 June still has the most deletions (473)."
    assert session.note_answer("added a table card of the 25 deletions from 18:00 to 19:00 UTC on 18 June. MartinHuber "
                               "made all of them.") == "MartinHuber made all of them."
    assert session.note_answer("I added a table of the deletions per minute and answered in the thread. The 18:21 "
                               "deletion is the first of 25.") == "The 18:21 deletion is the first of 25."
    # a note that is only the clause, or holds none, keeps its words
    assert session.note_answer("added a table card.") == "Added a table card."
    assert session.note_answer("the count went from 2.5 to 3. Then it fell.") == "The count went from 2.5 to 3. Then it fell."


def test_a_fork_whose_answer_is_only_its_closing_note_answers_the_thread_with_it(cwd, project, quits):
    """Live check term-fix6: a thread's fork wrote its answer only as a `↳ thread <name>: …` line, which only main's
    terminal shows, so the thread said `answered` with no words. Its last such line after its last tool call is the
    thread's reply once it ends; a note before a tool call (what it is about to do) is not."""
    p = project / f"{SID}.jsonl"
    p.write_text("")
    _subscribe(SID, cc_plugin.HOOK)
    lv = _attach(cwd, p, pid=100)
    session.tail_once(lv)
    tid = agents.new_thread(CORPUS, None, None, "Days the page changed")["id"]
    events.post(CORPUS, "thread", {"thread": tid, "text": QUESTION})
    name = agents.read_meta(CORPUS, tid)[threads.FORK_NAME_KEY]
    call = {"subagent_type": "fork", "description": f"thread:{name}", "prompt": f"thread:{name}"}
    _append(p, lv, [_human("Look into the thread"), _assistant(_use("toolu_f1", "Agent", call)),
                    _result("toolu_f1", "Async agent launched successfully.\nagentId: f0e1d2c3")])
    path = _fork_files(project, "f0e1d2c3", "toolu_f1", name, None)
    say = lambda text: {"type": "assistant", "isSidechain": True, "agentId": "f0e1d2c3",  # noqa: E731
                        "message": {"role": "assistant", "content": [_say(text)]}}
    _write(path, [say(f"↳ thread {name}: counting the saves per day."),
                  {"type": "assistant", "isSidechain": True, "agentId": "f0e1d2c3", "message": {"role": "assistant",
                   "content": [_use("toolu_wc", "Bash", {"command": "wc -l pages.jsonl"})]}},
                  say(f"↳ Thread {name}: added a table card of the saves per day. it changed on 16 and 18 June.")])
    session._scan_subs(lv)
    session.tail_once(lv)
    assert not [r for r in _log(tid) if r["type"] == "text"], "a note is no line of the thread while the fork works"
    note = ("<task-notification>\n<task-id>f0e1d2c3</task-id>\n<tool-use-id>toolu_f1</tool-use-id>\n"
            "<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>")
    _append(p, lv, [END, {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("The thread is answered.")), END])
    # without the clause that says what it made, a capital first (live check term-fix6, new quirk 3)
    assert [r["delta"] for r in _log(tid) if r["type"] == "text" and r.get("reply")] == ["It changed on 16 and 18 June."]
    assert [r["type"] for r in _log(tid) if r["type"] in ("done", "error")] == ["done"]
