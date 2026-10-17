"""session.py: the mirror of the analyst's Claude Code session. The transcript tail translates a turn and skips every
other record, and main follows its session when Claude Code moves it into a background job. Every transcript here is
written by the test in Claude Code's record shapes."""
from __future__ import annotations

import asyncio
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


def test_an_empty_text_block_claude_code_stores_as_no_content_shows_in_no_chat(cwd, tmp_path):
    """Bug hunt 3, D14: main ended a step with an empty text block, which Claude Code stores as "(no content)" and its
    terminal does not draw; the browser's chat showed it as a reply reading "(no content)". It is left out of the
    mirror and of the turn's rows for the answer checks."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [
        _human("Start a thread on the relay outage."),
        _assistant(_use("toolu_ag", "Agent", {"description": "relay outage", "prompt": "Look at the relay outage."})),
        _result("toolu_ag", "Started."),
        _assistant(_say("(no content)")),
    ])
    assert not [r for r in _mirror() if r["type"] == "text"], _mirror()
    assert not any("(no content)" in str(r.get("text")) for r in lv.turn_rows)
    _append(p, lv, [_assistant(_say("The thread is open.")), END])
    assert [(r["type"], r.get("delta")) for r in _mirror()][-2:] == [("text", "The thread is open."), ("done", None)]


# a PNG of one pixel
PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def test_i9_a_prompt_with_a_pasted_picture_and_its_answer_reach_main_s_chat_with_the_picture(cwd, tmp_path):
    """Bug hunt I9: a prompt with a picture holds an image block beside its text, which was no prompt for the mirror, so
    neither it nor main's answer reached the browser's chat. It is the analyst's line now, its picture kept in the
    workspace and named on the line, and the answer follows it."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [
        {"type": "user", "uuid": "08e84765-87c7-4445-a18a-81245b494aa4", "origin": {"kind": "human"}, "imagePasteIds": [1],
         "message": {"content": [{"type": "text", "text": "This is my browser: [Image #1] Make a bar chart card."},
                                 {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG}}]}},
        {"type": "user", "isMeta": True, "message": {"content": [{"type": "text", "text": "[Image: source: /tmp/x.png]"}]}},
        _assistant(_say("I made the bar chart card.")),
        END,
    ])
    recs = _mirror()
    assert [r["type"] for r in recs] == ["user", "text", "done"], recs
    assert recs[0]["text"] == "This is my browser: [Image #1] Make a bar chart card."
    assert recs[1]["delta"] == "I made the bar chart card."
    names = recs[0]["images"]
    assert len(names) == 1 and threads.picture_path(CORPUS, names[0]).read_bytes().startswith(b"\x89PNG")
    # a name that is no picture's is no file
    assert threads.picture_path(CORPUS, "../config.json") is None


def test_a_prompt_the_terminal_panel_sends_as_the_analyst_s_and_its_answer_reach_main_s_chat(cwd, tmp_path):
    """Bug hunt 2, C1: the terminal panel's `run again` and `describe a new label` send main a prompt as the analyst's
    ($.prompt.submit with asUser), which Claude Code records with origin {kind: plugin, name: thimble, asUser: true}.
    The mirror skipped it and main's answer, so the browser's chat never showed main's question to the analyst. Such a
    prompt is the analyst's line, marked with its plugin, sent idle or queued while main worked; a plugin's note to main
    (a meta record, no asUser) still shows nowhere."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    panel = {"kind": "plugin", "name": "thimble", "asUser": True}
    _append(p, lv, [
        {"type": "user", "isMeta": True, "origin": {"kind": "plugin", "name": "thimble"},
         "message": {"content": [{"type": "text", "text": "thimble: the analyst started thimble's view-builder"}]}},
        {"type": "user", "origin": panel, "promptSource": "system",
         "message": {"role": "user", "content": "Make a label with apply_label and try it on a sample of 30: probes"}},
        _assistant(_say("I made the label. Should coordination notes count as real content?")),
        {"type": "attachment", "attachment": {"type": "queued_command", "origin": panel,
                                              "prompt": "Run this card again with Bash: thimble-run card c1"}},
        _assistant(_say("I ran the card again.")),
        END,
    ])
    recs = [(r["type"], r.get("text") or r.get("delta"), r.get("plugin")) for r in _mirror()]
    assert recs == [
        ("user", "Make a label with apply_label and try it on a sample of 30: probes", "thimble"),
        ("text", "I made the label. Should coordination notes count as real content?", None),
        ("user", "Run this card again with Bash: thimble-run card c1", "thimble"),
        ("text", "I ran the card again.", None),
        ("done", None, None),
    ], recs
    assert not lv.degraded


def test_mains_model_and_effort_are_known_from_the_first_prompt_and_never_guessed(cwd, tmp_path):
    """B30: before main's first prompt the composer's chip has no effort to show but one the analyst's settings choose,
    not a top-level `effortLevel` in the user's file that Claude Code does not read for main's model; from the prompt on,
    the `model` attachment Claude Code writes with it names the model and the request main's thread sends names the
    effort, before any reply. A request of another query source changes nothing."""
    user = tmp_path / "claude-config" / "settings.json"
    user.parent.mkdir(parents=True, exist_ok=True)
    user.write_text(json.dumps({"effortLevel": "high"}))
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)

    def attached() -> dict:
        return (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {})["attached"]

    assert {"model", "effort", "settings_effort"}.isdisjoint(attached())
    _append(p, lv, [_human("What is in here?"), {"type": "attachment", "attachment": {
        "type": "model", "identity": {"modelId": "claude-opus-5-5", "marketingName": "Opus 5.5"}}}])
    assert attached()["model"] == "claude-opus-5-5" and "effort" not in attached()
    _append(p, lv, [
        {"type": "api-request", "querySource": "repl_main_thread",
         "params": {"model": "claude-opus-5-5", "output_config": {"effort": "medium"}}},
        {"type": "api-request", "querySource": "side_question",
         "params": {"model": "claude-haiku-4-5", "output_config": {"effort": "low"}}},
    ])
    assert (attached()["model"], attached()["effort"]) == ("claude-opus-5-5", "medium")
    assert not lv.degraded


def test_f17_a_resumed_session_s_model_is_known_from_the_reply_it_gave_before_the_attach(cwd, tmp_path):
    """Bug hunt F17: after `claude -c`, main had answered before the restart, yet the composer and Settings said its
    model was not known yet, since the tail does not replay the history it finds at the attach. The model and effort of
    the last reply before the tail's first place are read once."""
    p = tmp_path / f"{SID}.jsonl"
    reply = {"type": "assistant", "effort": "high", "message": {"role": "assistant", "model": "claude-opus-5-5",
                                                                "content": [_say("Agent-07 edited the most pages.")]}}
    error = {"type": "assistant", "message": {"role": "assistant", "model": "<synthetic>", "content": [_say("API Error")]}}
    p.write_text("".join(json.dumps(r) + "\n" for r in (_human("Who edited the most?"), reply, END, error)))
    lv = _attach(cwd, p)
    session.tail_once(lv)
    attached = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {})["attached"]
    assert (attached.get("model"), attached.get("effort")) == ("claude-opus-5-5", "high")
    assert _mirror() == [], "the history is not replayed"


def test_h5_a_turn_main_answered_while_no_server_followed_it_reaches_main_s_chat_when_the_session_comes_back(cwd, tmp_path):
    """Bug hunt H5: the analyst quit, `claude -c` brought the session back under its id, and main answered a turn before
    `/thimble browser` started the server again; that turn never reached main's chat in the browser, which read on from
    the transcript's end. A session that ended and comes back reads on from where the mirror stopped: the turn once,
    and nothing twice."""
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    session.tail_once(lv)
    _append(p, lv, [_human("Which page has the most revisions?"), _assistant(_say("WillkommenImWiki.")), END])
    session.detach(CORPUS, SID, "ended")  # the analyst quit
    _write(p, [_human("ok I'm back. where were we?"), _assistant(_say("The label stopped at 3 of 8 records.")), END])
    lv = _attach(cwd, p)  # `/thimble browser` in the continued session
    session.tail_once(lv)
    session.tail_once(lv)
    said = [r.get("text") or r.get("delta") for r in _mirror() if r["type"] in ("user", "text")]
    assert said == ["Which page has the most revisions?", "WillkommenImWiki.", "ok I'm back. where were we?",
                    "The label stopped at 3 of 8 records."]
    assert not lv.degraded


# ----------------------------------------------------------------------------- the startup sweep


async def test_the_sweep_gives_a_session_made_main_just_before_it_time_for_its_shim(cwd, tmp_path, monkeypatch):
    """0.8.0's live capture: on a new workspace a press attached main 0.5 s before the sweep, 30 s after the server's
    start, which detached it before its shim subscribed, and the browser said the session was disconnected until
    /thimble ran again. A session made main less than GRACE_S before the sweep gets GRACE_S for its shim, as after a
    shim leaves; one made main earlier whose shim never came is detached at once, as before."""
    stopped: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", stopped.append)
    monkeypatch.setattr(session, "_shutting_down", lambda: False)
    monkeypatch.setattr(session, "GRACE_S", 0.3)
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = _attach(cwd, p)
    assert session.sweep() == [] and session._live[CORPUS] is lv
    _subscribe(SID)  # its shim, a moment later
    await asyncio.sleep(0.5)
    assert session._live[CORPUS] is lv
    assert (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {})["attached"]["session"] == SID
    events._subs.clear()
    lv.attached_at -= 60  # made main a minute before the sweep, and its shim never came
    assert session.sweep() == [SID] and CORPUS not in session._live and stopped == []


async def test_turning_thimble_off_with_plugin_is_no_end_of_the_session(cwd, tmp_path, monkeypatch):
    """Bug hunt H19: /plugin off stops the plugin's shim, not the session, and runs no SessionEnd hook. The server took
    the shim's end for main's: it detached main as ended, stopped the orientation, which ran on in Claude Code, and
    stopped itself. While main's `claude` process runs, main stays main, its agents run on and the page says thimble
    is off; the shim's return takes that alert away; once the process is gone, main's session ended, as before."""
    from app import procs

    stopped: list[str] = []
    monkeypatch.setattr(session, "_stop_agents", stopped.append)
    monkeypatch.setattr(session, "_shutting_down", lambda: False)
    monkeypatch.setattr(session, "GRACE_S", 0.05)
    runs = {4242: True}
    monkeypatch.setattr(procs, "alive", lambda pid: runs.get(pid, False))
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    sub = _subscribe(SID)
    lv = _attach(cwd, p, pid=4242)

    def main() -> dict:
        return agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}

    events._subs[CORPUS].discard(sub)  # /plugin off: the shim stops, `claude` runs on
    session.disconnected(CORPUS, SID)
    await asyncio.sleep(0.3)
    assert session._live.get(CORPUS) is lv and main()["attached"]["session"] == SID and stopped == [], \
        "main is main still, and nothing of thimble's stopped"
    assert main()["alert"]["text"] == session.AWAY_TEXT and not main().get("ended")

    sub = _subscribe(SID)  # /plugin on: the shim subscribes again
    session.connected(CORPUS, SID, cwd, 4242)
    assert session._live.get(CORPUS) is lv and main()["alert"] is None

    events._subs[CORPUS].discard(sub)
    session.disconnected(CORPUS, SID)
    runs[4242] = False  # the analyst quit while the shim was gone: no SessionEnd hook ran either
    await asyncio.sleep(0.3)
    assert CORPUS not in session._live and main()["attached"] is None and stopped == [CORPUS]


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


@pytest.mark.parametrize("first", ["file", "tool_use"])
def test_a_thread_s_fork_joins_its_thread_whatever_main_passes_and_whichever_comes_first(cwd, project, quits, first):
    """Live check term-fix5, new quirk 1: main passed no `name`, so the fork's meta json named the thread only by its
    question (thimble-term's description), the mirror saw the file before main's tool_use, made a plain agent chat, and
    the thread never got its fork. Now the fork joins its thread in either order, by the agent-check hook's record of
    the call. The fork's steps and answer show in the thread, no agent chat is left in main, and its end finishes the
    thread."""
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
    call = {"subagent_type": "fork", "description": f"thread:{name}", "prompt": f"thread:{name}"}
    with subagents.update(CORPUS) as state:  # what the agent-check hook saw: thimble-term's description, main's prompt
        assert files.fork_check(state, {**call, "description": f"thread: {QUESTION}"}, None, "toolu_f1") is None
    tool_use = [_human("Look into the thread"), _assistant(_use("toolu_f1", "Agent", call)),
                _result("toolu_f1", "Async agent launched successfully.\nagentId: f0e1d2c3")]
    if first == "file":
        path = _fork_files(project, "f0e1d2c3", "toolu_f1", None, None)
        _fork_works(path, "f0e1d2c3")
        session._scan_subs(lv)
        session.tail_once(lv)
        _append(p, lv, tool_use)
    else:
        _append(p, lv, tool_use)
        path = _fork_files(project, "f0e1d2c3", "toolu_f1", None, None)
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


def test_main_s_message_to_a_thread_s_fork_by_its_name_keeps_the_thread_running(cwd, project, quits):
    """Live feedback, 10-17 ("wasn't sure if it was working or waiting"): main relays a follow-up to the thread's fork
    with SendMessage `to` the fork's name, as it named the fork; the mirror took that for no message, so at the end of
    main's turn the thread read "Main's turn ended without answering in this thread", in red, while the fork worked on
    the question. A message to the fork by its name counts as one by its agent id: the thread keeps running, with no
    such end."""
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
    call = {"subagent_type": "fork", "name": name, "description": f"thread:{name}", "prompt": f"thread:{name}"}
    with subagents.update(CORPUS) as state:
        assert files.fork_check(state, {**call, "description": f"thread: {QUESTION}"}, None, "toolu_f1") is None
    _append(p, lv, [_human("Look into the thread"), _assistant(_use("toolu_f1", "Agent", call)),
                    _result("toolu_f1", "Async agent launched successfully.\nagentId: f0e1d2c3")])
    path = _fork_files(project, "f0e1d2c3", "toolu_f1", name, None)
    _fork_works(path, "f0e1d2c3")
    session._scan_subs(lv)
    session.tail_once(lv)
    note = ("<task-notification>\n<task-id>f0e1d2c3</task-id>\n<tool-use-id>toolu_f1</tool-use-id>\n"
            "<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>")
    _append(p, lv, [END, {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": note}},
                    _assistant(_say("The thread is answered.")), END])
    assert not agents.running(CORPUS, tid)
    # the follow-up, as main gets it, relayed to the fork by its name
    sent = events.post(CORPUS, "thread", {"thread": tid, "text": "And by whom?"})
    event = f'<{events.TAG} kind="thread" thread="{tid}" event="{sent["id"]}">\nAnd by whom?\n</{events.TAG}>'
    relay = {"to": name, "summary": "Relay follow-up", "message": f"thread:{name} — the analyst asks in the thread: \"And by whom?\""}
    _append(p, lv, [{"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": event}},
                    _assistant(_use("toolu_s1", "SendMessage", relay)),
                    _result("toolu_s1", "Message sent; the agent resumes."), END])
    log = _log(tid)
    after = log[max(i for i, r in enumerate(log) if r["type"] == "user"):]
    assert not [r for r in after if r["type"] == "error"], after
    assert agents.running(CORPUS, tid)
