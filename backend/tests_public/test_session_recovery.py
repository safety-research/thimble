"""How the Claude Code sessions thimble starts beside main (agent_session.py) get past what would otherwise end them or
stall them: an allow on a call auto mode refused covers the call the model words anew; a session auto mode ended is
resumed, then waits for the analyst to switch its mode; a session a safety classifier stopped runs again on the
fallback model; a start of an orientation whose first run failed resumes it; the runs a server left running when it
stopped or died are resumed by the next server, and those that cannot be are closed with the reason, main hearing it
once a session listens. The stand-in CLI (FAKE) writes the transcript records Claude Code writes in each case, on
invented data."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
from pathlib import Path

import pytest

from app import agent_session, agents, channel, config, orient_session, orientation, session, tools

CORPUS = "mini"
KEY = orient_session.KEY
# Claude Code's words when auto mode's classifier gave no verdict too often
AUTO_OFF = ("Auto mode is unavailable: the server returned no safety verdict for 10 responses in a row, so Bash was "
            "not run and this turn has ended. Wait for the user's next message before doing anything further.")

FAKE = r'''
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
out = Path(os.environ["FAKE_DIR"])
with open(out / "argvs.jsonl", "a") as f:
    f.write(json.dumps(argv) + "\n")
n = sum(1 for _ in open(out / "argvs.jsonl"))
resume = "--resume" in argv
sid = argv[argv.index("--resume" if resume else "--session-id") + 1]
stdin = sys.stdin.read()
(out / "stdin.txt").write_text(stdin)
proj = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-corpus"
proj.mkdir(parents=True, exist_ok=True)
main = proj / f"{sid}.jsonl"
def put(*recs):
    with open(main, "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
def said(text):
    return {"type": "assistant", "message": {"model": "claude-opus-5-5", "content": [{"type": "text", "text": text}]}}
mode = os.environ.get("FAKE_MODE", "")
auto = "--permission-mode" in argv and argv[argv.index("--permission-mode") + 1] == "auto"
put({"type": "user", "message": {"role": "user", "content": stdin}})
if mode == "work":
    # a reader's temporary pickle and a cleaned copy, in the work folder the process runs in
    Path("tmp_ids").mkdir(exist_ok=True)
    Path("tmp_ids/revs.pkl").write_bytes(b"0" * 1000)
    Path("clean.csv").write_text("page,editor\n")
if mode == "models":
    # a reader that runs on another model partway through, and the session itself
    subs = proj / sid / "subagents"
    subs.mkdir(parents=True, exist_ok=True)
    meta = {"agentType": "general-purpose", "description": "Read revisions", "toolUseId": "t_ag"}
    (subs / "agent-r1.meta.json").write_text(json.dumps(meta))
    with open(subs / "agent-r1.jsonl", "a") as f:
        for m in ("claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-8"):
            f.write(json.dumps({"type": "assistant", "isSidechain": True, "message": {"model": m, "content": [
                {"type": "text", "text": "reading"}]}}) + "\n")
    put({"type": "assistant", "message": {"model": "claude-opus-5-5", "content": [{"type": "tool_use", "id": "t_ag",
         "name": "Agent", "input": {"subagent_type": "general-purpose", "description": "Read revisions"}}]}},
        {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t_ag",
         "content": "12 revisions"}]}},
        {"type": "assistant", "message": {"model": "claude-opus-5", "content": [{"type": "text", "text": "Opus 5"}]}})
if mode == "sleep" and n == 1:
    time.sleep(60)
    sys.exit(0)
if mode == "auto_off" and auto and n <= int(os.environ.get("FAKE_TIMES", "1")):
    # auto mode unavailable: the refusal as the call's result, marked as ending the turn, and exit 1
    put({"type": "assistant", "message": {"model": "claude-opus-5-5", "content": [
            {"type": "tool_use", "id": f"b{n}", "name": "Bash", "input": {"command": "grep -c edit edits.jsonl"}}]}},
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"b{n}", "is_error": True, "content": AUTO_OFF}]},
         "toolUseResult": "Error: " + AUTO_OFF, "toolDenialKind": "automode-unavailable", "toolDenialEndsTurn": True})
    print(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True}), flush=True)
    sys.exit(1)
model = argv[argv.index("--model") + 1] if "--model" in argv else ""
if mode in ("refused", "refused_went_on") and model != "claude-opus-4-8":
    # a writer whose response was stopped: the stopped response with its call, the call not run, Claude Code's
    # note, and its fallback model's reply
    write = {"type": "tool_use", "id": "w1", "name": "mcp__plugin_thimble_thimble__write_document",
             "input": {"doc": "notes"}}
    not_run = {"type": "tool_result", "tool_use_id": "w1", "is_error": True,
               "content": "Not run: the response that made this tool call was stopped by a safety classifier."}
    put({"type": "assistant", "message": {"model": model, "stop_reason": "refusal", "content": [write]}},
        {"type": "user", "message": {"role": "user", "content": [not_run]}},
        {"type": "system", "subtype": "model_refusal_fallback", "content": "Switched to Opus 5.",
         "fallbackModel": "claude-opus-5"})
    if mode == "refused_went_on":
        put({"type": "assistant", "message": {"model": "claude-opus-5", "content": [
            {"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "edits.jsonl"}}]}})
    put(said("I'm not able to continue drafting this document."))
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                      "result": "I'm not able to continue drafting this document."}), flush=True)
    sys.exit(0)
if mode == "critic_refused" and n == 1:
    time.sleep(60)  # the orientation, which waits on its critique
    sys.exit(0)
if mode == "critic_refused":
    # a critic whose response was stopped and then continued once, so it wrote its whole report; on the fallback
    # model it only points back to that report
    if model != "claude-opus-4-8":
        put({"type": "assistant", "message": {"model": "claude-opus-5-5", "stop_reason": "refusal", "content": []}},
            {"type": "system", "subtype": "informational",
             "content": "Opus 5.5's safeguards stopped the response above · continuing once with that noted"})
        text = os.environ["FAKE_REPORT"]
    else:
        text = "My review is complete and the report was delivered in full in my previous message."
    put(said(text))
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": text}), flush=True)
    sys.exit(0)
if mode == "fail_first" and n == 1:
    put(said("Counting the edits."))
    failed = {"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "boom"}
    print(json.dumps(failed), flush=True)
    sys.exit(1)
put(said(f"done {n}"))
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": f"done {n}"}), flush=True)
'''.replace("AUTO_OFF", repr(AUTO_OFF))


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    session._live.clear()
    channel._subs.clear()
    agent_session._runs.clear()
    yield
    channel._subs.clear()
    agent_session._runs.clear()


@pytest.fixture()
def fake(tmp_path, monkeypatch) -> Path:
    """The stand-in CLI as agent_session.CLAUDE_BIN, the config dir it writes into, and the folder it records into."""
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE}")
    script.chmod(0o755)
    out = tmp_path / "fake"
    out.mkdir()
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(script))
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    monkeypatch.setattr(agent_session, "STOP_WAIT_S", 1.0)
    monkeypatch.setenv("FAKE_DIR", str(out))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    monkeypatch.delenv("FAKE_MODE", raising=False)
    return out


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _heard(q: asyncio.Queue, kind: str) -> list[dict]:
    return [h for h in (q.get_nowait() for _ in range(q.qsize())) if h["meta"]["kind"] == kind]


def _argvs(fake: Path) -> list[list[str]]:
    return [json.loads(line) for line in (fake / "argvs.jsonl").read_text().splitlines()]


def _flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


async def _until(check, what: str, tries: int = 400) -> None:
    for _ in range(tries):
        if check():
            return
        await asyncio.sleep(0.025)
    raise AssertionError(what)


async def _done(run: agent_session.Run) -> None:
    await asyncio.wait_for(run.task, 10)


async def _auto_orientation(q: asyncio.Queue) -> agent_session.Run:
    channel.post(CORPUS, "start", {"text": "", "permissions": "auto"})
    return await orient_session.start(CORPUS, "")


# --------------------------------------------------------------------------- an allow covers the call made again


def _auto_run() -> agent_session.Run:
    run = agent_session.Run(CORPUS, KEY, "or1", "sid", Path("."), "orient", pid=1)
    agent_session._runs[(CORPUS, KEY)] = run
    return run


def test_an_allow_covers_the_agent_s_next_call_of_the_tool_once_when_the_model_words_it_anew():
    """An allow lets that agent's next call of the tool run, once, whatever its input, since the model may reword a
    refused command; another agent's or another tool's call is auto mode's to decide, and a deny covers only its own
    call."""
    run = _auto_run()
    allowed = {"behavior": "allow", "message": agent_session.ALLOWED_LINE}
    refused = {"command": "grep -rn 'moderator' revisions/ | sort | uniq -c | sort -rn", "description": "Count"}
    reworded = {"command": "grep -rn moderator revisions/ | head"}
    agent_session._remember(run, "a1", "Bash", refused, True, None)
    assert agent_session.before_call(CORPUS, KEY, "Bash", reworded, "a2") == {}, "another agent"
    assert agent_session.before_call(CORPUS, KEY, "Read", {"file_path": "revisions/a.txt"}, "a1") == {}, "another tool"
    assert agent_session.before_call(CORPUS, KEY, "Bash", reworded, "a1") == allowed
    assert agent_session.before_call(CORPUS, KEY, "Bash", refused, "a1") == {}, "one allow lets one call run"
    # the identical call made again uses the allow up, so a reworded one after it goes to auto mode
    agent_session._remember(run, "a1", "Bash", refused, True, None)
    assert agent_session.before_call(CORPUS, KEY, "Bash", {**refused, "description": "Count again"}, "a1") == allowed
    assert agent_session.before_call(CORPUS, KEY, "Bash", {"command": "ls"}, "a1") == {}
    # a deny answers its own call, and leaves the agent's other calls to auto mode
    agent_session._remember(run, "a1", "Bash", {"command": "rm -rf out"}, False, None)
    assert agent_session.before_call(CORPUS, KEY, "Bash", {"command": "rm -rf out/"}, "a1") == {}
    assert agent_session.before_call(CORPUS, KEY, "Bash", {"command": "rm -rf out"}, "a1") == \
        {"behavior": "deny", "message": agent_session.DENIED_LINE}


def test_an_allow_the_model_never_uses_expires(monkeypatch):
    run = _auto_run()
    agent_session._remember(run, None, "Bash", {"command": "ls"}, True, None)
    later = agent_session.time.monotonic() + agent_session.GRANT_TTL_S + 1
    monkeypatch.setattr(agent_session.time, "monotonic", lambda: later)
    assert agent_session.before_call(CORPUS, KEY, "Bash", {"command": "ls -la"}) == {}
    assert agent_session.before_call(CORPUS, KEY, "Bash", {"command": "ls"}) == {}


# --------------------------------------------------------------------------- auto mode ended the session


async def test_an_orientation_auto_mode_ended_is_resumed_in_auto_with_its_work(fake, monkeypatch):
    """A session auto mode ends because its classifier gave no verdict too often is resumed in Auto with
    `## session-resumed`, into the same chat, and main hears that it finished."""
    monkeypatch.setenv("FAKE_MODE", "auto_off")
    monkeypatch.setenv("FAKE_TIMES", "2")
    q = _listen()
    run = await _auto_orientation(q)
    await _done(run)
    argvs = _argvs(fake)
    assert len(argvs) == 3, "the first process and two resumes"
    assert all(_flag(a, "--permission-mode") == "auto" for a in argvs)
    assert [_flag(a, "--resume") for a in argvs[1:]] == [run.sid, run.sid]
    assert (fake / "stdin.txt").read_text() == tools.hint(agent_session.RESUMED_PROMPT, stopped="")
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "done" and not meta.get("alert")
    [end] = _heard(q, orientation.ORIENT_KIND)
    assert end["meta"]["status"] == "done"
    records = [json.loads(line) for line in agents.paths(CORPUS, run.chat)[1].read_text().splitlines()]
    refused = [r for r in records if r.get("type") == "tool_result" and r.get("id") in ("b1", "b2")]
    assert len(refused) == 2 and all(r.get("not_run") and not r.get("is_error") for r in refused), \
        "the calls auto mode refused show as not run, rather than failed"


async def test_once_its_resumes_are_spent_the_orientation_waits_for_the_analyst_to_switch_it(fake, monkeypatch):
    """After AUTO_RESUMES resumes in a row the orientation waits with no process, its alert naming why, until the
    analyst switches it to Manual on its card, which resumes it in Claude Code's manual mode with its work."""
    monkeypatch.setenv("FAKE_MODE", "auto_off")
    monkeypatch.setenv("FAKE_TIMES", "99")
    monkeypatch.setattr(agent_session, "AUTO_RESUMES", 1)
    q = _listen()
    run = await _auto_orientation(q)
    alert = lambda: agents.read_meta(CORPUS, run.chat).get("alert") or {}  # noqa: E731
    await _until(lambda: alert().get("cause") == agent_session.AUTO_OFF_KIND, "no alert")
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["alert"]["kind"] == "retry" and "Auto mode's safety check gave no verdict" in meta["alert"]["text"]
    assert meta["status"] == "running" and meta["pid"] is None and orient_session.running(CORPUS)
    assert len(_argvs(fake)) == 2
    assert agent_session.set_mode(CORPUS, run.chat, "manual") == {"mode": "manual", "switching": None}
    await _done(run)
    argvs = _argvs(fake)
    assert len(argvs) == 3 and _flag(argvs[2], "--permission-mode") == "default"
    assert _flag(argvs[2], "--resume") == run.sid
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "done" and not meta.get("alert") and meta["permission_mode"] == "manual"
    assert orientation.read_run(CORPUS)["permissions"] == "manual", "a follow-up runs in Manual too"


async def test_a_session_in_the_analyst_s_own_auto_mode_fails_with_claude_code_s_words(fake, monkeypatch):
    """A session with no mode of thimble's has no switch to wait for: once its resumes are spent it fails, and its
    summary is Claude Code's own line, never a bare exit code."""
    monkeypatch.setenv("FAKE_MODE", "auto_off")
    monkeypatch.setenv("FAKE_TIMES", "99")
    monkeypatch.setattr(agent_session, "AUTO_RESUMES", 1)
    ended: list[tuple[str, str]] = []
    run = await agent_session.start(CORPUS, "writer:notes", role="writer", title="Write notes", agent_args=[],
                                    effort="high", settings=agent_session.settings_json("high"),
                                    prompt="Write the notes", agent_type="writer", permission_mode="auto",
                                    on_end=lambda r, status, summary: ended.append((status, summary)))
    await _done(run)
    assert len(_argvs(fake)) == 2
    assert ended == [("failed", AUTO_OFF)]
    assert agents.read_meta(CORPUS, run.chat)["result"] == AUTO_OFF


# --------------------------------------------------------------------------- a safety classifier stopped the model


async def _writer(model: str, ended: list) -> agent_session.Run:
    return await agent_session.start(CORPUS, "writer:notes", role="writer", title="Write notes", agent_args=[],
                                     effort="high", settings=agent_session.settings_json("high"),
                                     prompt="Write the notes", agent_type="writer", model=model,
                                     on_end=lambda r, status, summary: ended.append((status, summary)))


async def test_a_session_a_safety_classifier_stopped_runs_again_once_on_the_fallback_model(fake, monkeypatch):
    """A session whose work its model's safeguards stop, here a writer on its default model, runs again on the
    fallback model with its work, and its thread and main each get a line saying so."""
    monkeypatch.setenv("FAKE_MODE", "refused")
    ended: list = []
    default = config.agent_front("writer")["model"]
    assert default == "claude-opus-5-5"
    run = await _writer(default, ended)
    await _done(run)
    first, second = _argvs(fake)
    assert _flag(first, "--model") == "claude-opus-5-5"
    assert _flag(second, "--model") == agent_session.FALLBACK_MODEL == "claude-opus-4-8"
    assert _flag(second, "--resume") == run.sid
    assert (fake / "stdin.txt").read_text() == tools.hint(agent_session.FALLBACK_PROMPT, model="Opus 5.5",
                                                          fallback="Opus 4.8", stopped="")
    assert ended == [("done", "done 2")]
    note = agent_session.FALLBACK_NOTE.format(model="Opus 5.5", fallback="Opus 4.8")
    thread = agents.read_events(agents.paths(CORPUS, run.chat)[1])
    assert any(r["type"] == "chip" and r["text"] == note for r in thread)
    main = agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])
    assert any(r["type"] == "chip" and r["text"] == note and r.get("chat") == run.chat for r in main)
    assert agents.read_meta(CORPUS, run.chat)["model"] == "claude-opus-4-8"


async def test_a_session_that_went_on_after_a_stop_or_runs_on_the_fallback_is_not_run_again(fake, monkeypatch):
    """A session whose fallback made a call after the stopped response went on with its work, so its end is its own;
    and one already on the fallback model has nowhere else to go."""
    monkeypatch.setenv("FAKE_MODE", "refused_went_on")
    ended: list = []
    await _done(await _writer("claude-fable-5-1", ended))
    assert len(_argvs(fake)) == 1 and ended[0][0] == "done"
    (fake / "argvs.jsonl").unlink()
    monkeypatch.setattr(agent_session, "FALLBACK_MODEL", "claude-fable-5-1")
    monkeypatch.setenv("FAKE_MODE", "refused")
    await _done(await _writer("claude-fable-5-1", ended))
    assert len(_argvs(fake)) == 1


async def test_a_critique_whose_critic_answered_before_its_fallback_returns_that_answer_first(fake, monkeypatch):
    """The critic's process ends with its whole report after Claude Code continued past a stopped response, and the
    rerun on the fallback model only points back to it: the critique returns the report, then the rerun's reply."""
    report = "Three problems: the switch counts measure retries [[call:or1/12]], and episode 9's health check is faked."
    monkeypatch.setenv("FAKE_MODE", "critic_refused")
    monkeypatch.setenv("FAKE_REPORT", report)
    await orient_session.start(CORPUS, "")
    await _until(lambda: orient_session.current(CORPUS) is not None and orient_session.current(CORPUS).pid,
                 "the orientation's start")
    try:
        res = await asyncio.wait_for(tools.call(CORPUS, "critique", {"context": "the runs"}, session=KEY), 30)
    finally:
        await orient_session.stop(CORPUS)
    assert not res.is_error, res.text
    answer = res.text.split("\n", 1)[1]  # after the call's own line
    assert answer.startswith(report) and answer.endswith("delivered in full in my previous message.")
    critic = _argvs(fake)[1:]
    assert len(critic) == 2 and _flag(critic[1], "--model") == agent_session.FALLBACK_MODEL
    run = agent_session.Run(CORPUS, "k", "c", "s", Path("."), "step", before_fallback=report)
    assert agent_session.with_earlier(run, f"{report}\n\nand one more") == f"{report}\n\nand one more"
    assert agent_session.with_earlier(run, "") == report


# --------------------------------------------------------------------------- a failed orientation started again


async def test_starting_a_failed_orientation_again_resumes_its_session(fake, monkeypatch):
    """A start that asks for the same orientation as a failed one (its brief, or none, and its outputs) resumes the
    failed session as run 0 in the same chat; one with another brief starts a new orientation."""
    monkeypatch.setenv("FAKE_MODE", "fail_first")
    q = _listen()
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _done(run)
    assert orientation.read_run(CORPUS)["status"] == "failed"
    [end] = _heard(q, orientation.ORIENT_KIND)
    assert end["meta"]["status"] == "failed" and end["content"].endswith("boom")
    res = await tools.call(CORPUS, "start_orientation", {"brief": "the edits", "final_notebook": True,
                                                         "propose_views": False})
    assert not res.is_error, res.text
    again = orient_session.current(CORPUS)
    assert again.chat == run.chat and again.sid == run.sid and again.k == 0
    await _done(again)
    first, second = _argvs(fake)
    assert _flag(second, "--resume") == run.sid and "--session-id" not in second
    assert (fake / "stdin.txt").read_text() == tools.hint(agent_session.RESUMED_PROMPT, stopped="")
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "done" and rec["run"] == 0 and not rec.get("error")
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done"
    rows = [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1])
            if r["type"] == "agent" and r.get("chat") == run.chat]
    assert len(rows) == 1, "main keeps one row for the first run, which ran again"
    # a failure, then a start with another brief: a new orientation
    (fake / "argvs.jsonl").unlink()
    orientation._write_run(CORPUS, {**rec, "status": "failed"})
    other = await orient_session.start(CORPUS, "the editors", ["final"])
    await _done(other)
    assert other.chat != run.chat and "--session-id" in _argvs(fake)[0]


# --------------------------------------------------------------------------- what a run leaves and what it notes


async def test_an_orientation_s_temporary_files_go_when_a_run_ends_and_stay_when_it_failed(fake, monkeypatch):
    """The readers' `tmp_*` pickles in an orientation's work folder go when a run ends; a cleaned copy stays, since a
    card may read it, and a failed run keeps them all, since a start resumes it."""
    monkeypatch.setenv("FAKE_MODE", "work")
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _done(run)
    work = orient_session.work_dir(CORPUS)
    assert not (work / "tmp_ids").exists() and (work / "clean.csv").is_file()
    (work / "tmp_ids").mkdir()
    rec = orientation.read_run(CORPUS)
    orientation._write_run(CORPUS, {**rec, "status": "running"})
    agents.update_agent(CORPUS, run.chat, status="running")
    orient_session._ended(run, "failed", "boom")
    assert (work / "tmp_ids").is_dir()


async def test_a_model_claude_code_switched_an_agent_to_is_noted_in_the_session_s_thread(fake, monkeypatch):
    """Claude Code may move an agent to another model mid-run. The session's thread gets a line the first time the
    replies of the session or of one of its agents come from another model, and the agent's chat names the model."""
    monkeypatch.setenv("FAKE_MODE", "models")
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _done(run)
    notes = [r["text"] for r in agents.read_events(agents.paths(CORPUS, run.chat)[1]) if r["type"] == "chip"]
    assert sorted(notes) == sorted([
        agent_session.MODEL_NOTE.format(who="the agent “Read revisions”", first="Opus 5.5", model="Opus 4.8"),
        agent_session.MODEL_NOTE.format(who="this session", first="Opus 5.5", model="Opus 5")])
    [step] = [m for m in agents.list_chats(CORPUS) if m.get("parent") == run.chat]
    assert step["model"] == "claude-opus-4-8"


def test_a_call_a_pause_s_signal_cut_off_shows_as_not_run(tmp_path):
    """A Bash call a switch to Manual cuts off just before the pause shows as not run, not failed with Claude Code's
    rejection, since the resumed session makes it again."""
    path = tmp_path / "s.jsonl"
    copied = json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t_old", "is_error": True, "content": agent_session.CUT_OFF}]}}) + "\n"
    cut = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_cut", "is_error": True,
                                                    "content": agent_session.CUT_OFF + " STOP what you are doing."}]}}
    failed = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_err", "is_error": True,
                                                       "content": "exit 1"}]}}
    path.write_text(copied + json.dumps(cut) + "\n" + json.dumps(failed) + "\n")
    run = agent_session.Run(CORPUS, KEY, "or1", "sid", Path("."), "orient")
    run.main = session.Sub(CORPUS, "or1", None, None, role="orient")
    run.main.path, run.main.offset = path, len(copied)
    agent_session._not_run_cut_off(run)
    assert "t_cut" in session._not_run and "t_err" not in session._not_run
    assert "t_old" not in session._not_run, "a result the follower copied already is left as it was"


# --------------------------------------------------------------------------- what a previous server left running


async def _abandon(run: agent_session.Run) -> int:
    """What a server that died leaves: the run's process still going and its chat saying it runs, with no follower."""
    pid = run.pid
    run.pid = None  # so the follower's end, cancelled here, signals nothing
    run.task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run.task
    agent_session._runs.pop((run.c, run.key), None)
    assert agent_session.procs.alive(pid) and agents.read_meta(CORPUS, run.chat)["status"] == "running"
    return pid


def _main_rows(chat: str) -> list[dict]:
    return [r for r in agents.read_events(agents.paths(CORPUS, agents.MAIN_ID)[1]) if r.get("chat") == chat]


def _chips(chat: str) -> list[str]:
    return [r["text"] for r in agents.read_events(agents.paths(CORPUS, chat)[1]) if r["type"] == "chip"]


async def test_an_orientation_a_dead_server_left_running_is_resumed_at_the_next_start(fake, monkeypatch):
    """An orientation a server that died left running is resumed by the next server's start: its process ended, its
    session resumed with `--resume` in the same chat as the same run, the reader that stopped with it named, and its
    thread and main saying it resumed. Main hears only its end."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    reader = agents.new_agent(CORPUS, agent_session.STEP_ROLE, "Read revisions", parent=run.chat, announce=False,
                              agent_id="a1b2")
    pid = await _abandon(run)
    q = _listen()
    closed, resumed = await agent_session.recover()
    assert (closed, resumed) == ([], [f"{CORPUS}/{run.chat}"])
    assert not agent_session.procs.alive(pid)
    await asyncio.wait_for(run.proc.wait(), 5)
    again = orient_session.current(CORPUS)
    assert again.chat == run.chat and again.sid == run.sid and again.k == 0 and "a1b2" in again.halted
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "running" and meta["pid"] == again.pid and meta["restarted"]["run"] == 0
    assert agents.read_meta(CORPUS, reader["id"])["status"] == "stopped"
    assert orientation.read_run(CORPUS)["pid"] == again.pid and orientation.running(CORPUS)
    await _done(again)
    argv = _argvs(fake)[-1]
    assert _flag(argv, "--resume") == run.sid and "--session-id" not in argv
    named = agent_session.stopped_text([agents.read_meta(CORPUS, reader["id"])])
    assert (fake / "stdin.txt").read_text() == tools.hint(agent_session.RESTARTED_PROMPT, stopped=f"{named} ")
    assert agent_session.RESTARTED_NOTE in _chips(run.chat)
    rows = _main_rows(run.chat)
    assert [r["type"] for r in rows if r["type"] == "agent"] == ["agent"], "main keeps its one row for the run"
    assert [r["text"] for r in rows if r["type"] == "chip"] == [agent_session.RESTARTED_NOTE]
    rec = orientation.read_run(CORPUS)
    assert rec["status"] == "done" and rec["run"] == 0 and agents.read_meta(CORPUS, run.chat)["status"] == "done"
    assert [h["meta"]["status"] for h in _heard(q, orientation.ORIENT_KIND)] == ["done"], "main hears its end alone"


async def test_a_restart_s_stop_leaves_the_orientation_for_the_next_server_and_main_hears_nothing(fake, monkeypatch):
    """A restart's shutdown ends the orientation's process and leaves its chat and record running for the next server,
    which resumes it; main hears nothing until it ends."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    q = _listen()
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    await agent_session.shutdown()
    assert run.proc.returncode is not None and not orient_session.running(CORPUS)
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "running" and meta["pid"] is None and not meta.get("result")
    assert orientation.read_run(CORPUS)["status"] == "running"
    assert _heard(q, orientation.ORIENT_KIND) == [] and not agent_session._unheard_path(CORPUS).exists()
    closed, resumed = await agent_session.recover()
    assert (closed, resumed) == ([], [f"{CORPUS}/{run.chat}"])
    await _done(orient_session.current(CORPUS))
    assert orientation.read_run(CORPUS)["status"] == "done"
    assert [h["meta"]["status"] for h in _heard(q, orientation.ORIENT_KIND)] == ["done"]


async def test_an_orientation_that_cannot_resume_fails_with_why_and_a_start_resumes_it_later(fake, monkeypatch):
    """A run the next server cannot resume ends failed with the reason on its card and in main's line, which waits
    until a session listens, and a start of the same orientation resumes its session."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    await _abandon(run)
    claude = agent_session.CLAUDE_BIN
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(fake / "no-claude"))
    closed, resumed = await agent_session.recover()
    assert (closed, resumed) == ([f"{CORPUS}/{run.chat}"], [])
    await asyncio.wait_for(run.proc.wait(), 5)
    meta = agents.read_meta(CORPUS, run.chat)
    stopped = tools.hint(agent_session.SERVER_STOPPED)
    assert meta["status"] == "failed" and meta["pid"] is None
    assert meta["result"].startswith(f"{stopped} It could not be resumed: could not start") and "no-claude" in meta["result"]
    assert orientation.read_run(CORPUS)["status"] == "failed" and not orient_session.running(CORPUS)
    assert agent_session._unheard_path(CORPUS).is_file(), "main's line waits for a session"
    assert await agent_session.recover() == ([], []), "closed once"
    q = _listen()
    assert agent_session.deliver_unheard(CORPUS) == 1
    [end] = _heard(q, orientation.ORIENT_KIND)
    assert end["meta"]["status"] == "failed" and "It could not be resumed" in end["content"]
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", claude)
    again = await orient_session.start(CORPUS, "the edits", ["final"])
    await _done(again)
    assert again.chat == run.chat and _flag(_argvs(fake)[-1], "--resume") == run.sid
    assert orientation.read_run(CORPUS)["status"] == "done"


async def test_a_run_whose_transcript_is_gone_or_whose_workspace_is_a_copy_is_closed(fake, monkeypatch):
    """A session Claude Code no longer keeps cannot resume, and says so; a chat whose workspace folder is another
    (a copy of the workspace) is closed, never resumed from the copy."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    await _abandon(run)
    agents.update_agent(CORPUS, run.chat, workspace_dir="/elsewhere/workspaces/mini")
    assert await agent_session.recover() == ([f"{CORPUS}/{run.chat}"], [])
    assert agents.read_meta(CORPUS, run.chat)["result"] == tools.hint(agent_session.SERVER_STOPPED)

    (fake / "argvs.jsonl").unlink()  # so the next process sleeps too
    orientation._write_run(CORPUS, {**orientation.read_run(CORPUS), "status": "failed"})
    run = await orient_session.start(CORPUS, "the editors", ["final"])
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    await _abandon(run)
    run.main.path.unlink()
    assert await agent_session.recover() == ([f"{CORPUS}/{run.chat}"], [])
    why = tools.hint(agent_session.NOT_RESUMED, why=agent_session.GONE_TRANSCRIPT)
    assert agents.read_meta(CORPUS, run.chat)["result"] == f"{tools.hint(agent_session.SERVER_STOPPED)} {why}"


async def test_a_writer_left_running_resumes_and_its_document_shows_as_being_written(fake, monkeypatch):
    """A writer a restart's shutdown left is resumed in its chat by the next server, and its document shows as being
    written again until it ends."""
    from app import report_types, write_session  # noqa: F401 — write_session registers the writer's resume

    emitted: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, event: emitted.append(event))
    monkeypatch.setenv("FAKE_MODE", "sleep")
    q = _listen()
    run = await agent_session.start(CORPUS, write_session.session_key("report"), prompt="Write the report",
                                    **write_session._launch(CORPUS, "report"))
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    await agent_session.shutdown()
    assert agents.read_meta(CORPUS, run.chat)["status"] == "running" and _heard(q, "written") == []
    assert await agent_session.recover() == ([], [f"{CORPUS}/{run.chat}"])
    again = agent_session.current(CORPUS, write_session.session_key("report"))
    assert again.chat == run.chat and again.sid == run.sid
    assert report_types.write_pending(CORPUS, "report") is not None
    assert {"type": "report", "slug": "report", "status": "generating", "by": report_types.ANALYST, "run": None} in emitted
    await _done(again)
    assert _flag(_argvs(fake)[-1], "--resume") == run.sid
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done"
    assert [h["meta"]["status"] for h in _heard(q, "written")] == ["done"]


async def test_a_writer_whose_document_is_gone_shows_its_write_failed_and_stop_closes_a_stale_run(fake, monkeypatch):
    """A writer left running whose document is gone shows its write as failed on its document with why, and main
    hears it; and Stop on a chat that says it runs with no session behind it closes it."""
    from app import report_types, write_session  # noqa: F401 — write_session registers the writer's end (on_left)

    emitted: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, event: emitted.append(event))
    monkeypatch.setenv("FAKE_MODE", "sleep")
    q = _listen()
    run = await agent_session.start(CORPUS, "writer:notes", role="writer", title="Write notes", agent_args=[],
                                    effort="high", settings=agent_session.settings_json("high"),
                                    prompt="Write the notes", agent_type="writer", doc="notes")
    await _until(lambda: run.main is not None and run.main.path is not None, "no transcript")
    await _abandon(run)
    assert await agent_session.recover() == ([f"{CORPUS}/{run.chat}"], [])
    await asyncio.wait_for(run.proc.wait(), 5)
    why = (f"{tools.hint(agent_session.SERVER_STOPPED)} "
           f"{tools.hint(agent_session.NOT_RESUMED, why='its document notes no longer exists')}")
    assert emitted == [{"type": "report", "slug": "notes", "status": "failed", "chat": run.chat, "note": why}]
    [end] = _heard(q, "written")
    assert end["meta"]["status"] == "failed" and end["content"] == why

    (fake / "argvs.jsonl").unlink(missing_ok=True)  # so the next process sleeps too
    run = await agent_session.start(CORPUS, "writer:notes", role="writer", title="Write notes", agent_args=[],
                                    effort="high", settings=agent_session.settings_json("high"),
                                    prompt="Write the notes", agent_type="writer", doc="notes")
    pid = await _abandon(run)
    assert await agent_session.stop_chat(CORPUS, run.chat) is True
    await asyncio.wait_for(run.proc.wait(), 5)
    assert not agent_session.procs.alive(pid) and agents.read_meta(CORPUS, run.chat)["status"] == "stopped"
    assert await agent_session.stop_chat(CORPUS, run.chat) is False, "nothing left to stop"


async def test_a_session_another_live_server_follows_is_left_alone_until_that_server_is_gone(fake):
    """A copy of a workspace holds its chats as they stood, so a server started on a copy (the dev agent's
    validation stack) could take the analyst's running writer for one a dead server left. A chat whose process is
    still the child of the live server that started it is left as it is, by the start and by Stop; once that server is
    gone, the process is closed."""
    sid = "5e55a1d0-0000-4000-8000-000000000001"
    # the other server: it starts the session's stand-in in a process group of its own, as agent_session does
    code = ("import subprocess, sys, time\n"
            f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', '{sid}'], "
            "start_new_session=True, stdout=subprocess.DEVNULL)\nprint(p.pid, flush=True)\ntime.sleep(60)\n")
    other = await asyncio.create_subprocess_exec(sys.executable, "-c", code, stdout=asyncio.subprocess.PIPE)
    child = 0
    try:
        child = int((await asyncio.wait_for(other.stdout.readline(), 10)).decode())
        chat = str(agents.new_agent(CORPUS, "writer", "Write notes", session=sid, pid=child, server=other.pid)["id"])
        assert await agent_session.recover() == ([], [])
        assert agent_session.procs.alive(child) and agents.read_meta(CORPUS, chat)["status"] == "running"
        assert await agent_session.stop_chat(CORPUS, chat) is False and agent_session.procs.alive(child)
        other.kill()
        await other.wait()
        await _until(lambda: agent_session.procs.ppid(child) != other.pid, "the stand-in kept its parent")
        assert await agent_session.recover() == ([f"{CORPUS}/{chat}"], [])
        await _until(lambda: not agent_session.procs.alive(child), "the stand-in outlived its server's successor")
        assert agents.read_meta(CORPUS, chat)["status"] == "failed"
    finally:
        with contextlib.suppress(ProcessLookupError):
            other.kill()
        await other.wait()
        if child and agent_session.procs.alive(child):
            with contextlib.suppress(ProcessLookupError):
                os.kill(child, signal.SIGKILL)


async def test_a_session_no_caller_resumes_fails_at_the_server_s_stop_and_the_next_server_tells_main(fake, monkeypatch):
    """A session no caller resumes, such as a report check's run, ends failed with the reason at a restart's
    shutdown, and main's line, kept on disk while no session listens (409), reaches main from the next server once one
    listens."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await agent_session.start(CORPUS, "check:numbers:report", role="check", title="Numbers match", agent_args=[],
                                    effort="high", settings=agent_session.settings_json("high"),
                                    prompt="Check the numbers", agent_type="checker",
                                    on_end=lambda r, status, summary: agent_session.tell_main(
                                        r.c, "written", {"text": summary, "status": status, "doc": "report"}))
    await asyncio.sleep(0.2)
    await agent_session.shutdown()
    why = tools.hint(agent_session.SERVER_STOPPED)
    assert agents.read_meta(CORPUS, run.chat)["status"] == "failed"
    assert json.loads(agent_session._unheard_path(CORPUS).read_text())[0]["payload"]["text"] == why
    agent_session._unheard.clear()  # the next server knows only the file
    assert await agent_session.recover() == ([], [])
    q = _listen()
    assert agent_session.deliver_unheard(CORPUS) == 1
    [end] = _heard(q, "written")
    assert end["meta"]["status"] == "failed" and end["content"] == why


async def test_the_running_route_names_what_a_restart_interrupts_and_what_resumes(fake, monkeypatch):
    """`thimble server restart` names what it would interrupt before it asks: the route lists each session the server
    runs with whether the next server resumes it, less a critique, and each view being built."""
    from app import views

    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "the edits", ["final"])
    check = await agent_session.start(CORPUS, "check:numbers:report", role="check", title="Numbers match",
                                      agent_args=[], effort="high", settings=agent_session.settings_json("high"),
                                      prompt="Check the numbers", agent_type="checker")
    views._save_proposals(CORPUS, [{"slug": "edit-timeline", "name": "Edit timeline", "status": "building"},
                                   {"slug": "editors", "name": "Editors", "status": "queued"}])
    try:
        got = await agent_session.running_route()
        assert got == [
            {"workspace": CORPUS, "kind": "orient", "title": orientation.TITLE, "run": 0, "resumes": True},
            {"workspace": CORPUS, "kind": "check", "title": "Numbers match", "run": 0, "resumes": False},
            {"workspace": CORPUS, "kind": "view", "title": "Edit timeline", "resumes": True}]
    finally:
        await agent_session.stop_run(run)
        await agent_session.stop_run(check)
