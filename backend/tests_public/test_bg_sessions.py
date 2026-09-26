"""thimble's agents as Claude Code background sessions in terminal-first mode (bg_session.py): a writer starts as a
`claude --bg` session named thimble:writer, its run ends when the session is idle with its turn ended while the session
goes on, a turn the session starts on its own is followed as the chat's next run, and a message for it waits in its
outbox for the tray entry (the proxy) to send, which the relay hook swaps in, once. The proxy's wait returns the
session's news, the stop hook keeps it going while its session runs, and a second proxy is told to stop. A restart
follows a running session again; a session whose process went away leaves its chat stopped. The statusline and
/thimble:agents list every running agent, and the hooks print a start and a finish line once.

A stand-in CLI (FAKE_BG) keeps its sessions in a JSON file: `claude --bg` starts one and writes its transcript,
`--bg --resume` wakes a stopped one under its id, `agents --json` lists them and `stop` ends one's process."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

from app import agent_session, agents, bg_session, channel, config, ledger, session, tools, write_session

CORPUS = "mini"

FAKE_BG = r'''
import json, os, sys, uuid
from pathlib import Path
out = Path(os.environ["FAKE_DIR"])
state_path = out / "sessions.json"
state = json.loads(state_path.read_text()) if state_path.exists() else {}
argv = sys.argv[1:]
with open(out / "argvs.jsonl", "a") as f:
    f.write(json.dumps(argv) + "\n")
proj = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-corpus"
proj.mkdir(parents=True, exist_ok=True)
def put(sid, *recs):
    with open(proj / f"{sid}.jsonl", "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
def turn(sid, prompt, reply, end=True):
    error = reply.startswith("API Error")
    put(sid, {"type": "user", "message": {"role": "user", "content": prompt}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": reply}]}, **({"isApiErrorMessage": True} if error else {})},
        *([{"type": "system", "subtype": "turn_duration"}] if end else []))
if argv[:1] == ["agents"]:
    print(json.dumps([{"id": s["sid"][:8], "sessionId": s["sid"], "kind": "background", "name": s["name"],
                       "status": s["status"], "pid": s["pid"], "cwd": s["cwd"]} for s in state.values()]))
    sys.exit(0)
if argv[:1] == ["stop"]:
    state[argv[1]]["pid"] = None
    state_path.write_text(json.dumps(state))
    print("stopped " + argv[1])
    sys.exit(0)
if "--bg" in argv:
    prompt = argv[argv.index("--") + 1]
    if "--resume" in argv:
        sid = argv[argv.index("--resume") + 1]
        s = state[sid[:8]]
        s["pid"], s["status"] = 4242, "idle"
        turn(sid, prompt, "carried on")
    else:
        if (Path.cwd() / ".thimble-first-message.md").exists() and "first message is in" in prompt:
            prompt = (Path.cwd() / ".thimble-first-message.md").read_text()
        sid = str(uuid.uuid4())
        name = argv[argv.index("-n") + 1]
        busy = os.environ.get("FAKE_BUSY") == "1"  # the session keeps working until the test says otherwise
        s = state[sid[:8]] = {"sid": sid, "name": name, "status": "busy" if busy else "idle", "pid": 4242, "cwd": os.getcwd()}
        turn(sid, prompt, os.environ.get("FAKE_REPLY", "Wrote the report."), end=not busy)
    state_path.write_text(json.dumps(state))
    print(f"backgrounded · {sid[:8]} · {s['name']}")
    sys.exit(0)
sys.exit(2)
'''


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    session._live.clear()
    channel._subs.clear()
    agent_session._runs.clear()
    agent_session._launches.clear()
    bg_session._entries.clear()
    bg_session._loaded.clear()
    bg_session._announced.clear()
    monkeypatch.setattr(bg_session, "_closing", False)
    monkeypatch.setattr(bg_session, "POLL_S", 0.05)
    monkeypatch.setattr(bg_session, "START_GRACE_S", 0.0)
    monkeypatch.setattr(bg_session, "WAIT_S", 0.3)
    monkeypatch.setattr(agent_session, "POLL_S", 0.05)
    yield
    if bg_session._task is not None:
        bg_session._task.cancel()
        bg_session._task = None
    channel._subs.clear()
    agent_session._runs.clear()
    bg_session._entries.clear()


@pytest.fixture()
def fake(tmp_path, monkeypatch) -> Path:
    script = tmp_path / "claude"
    script.write_text(f"#!{sys.executable}\n{FAKE_BG}")
    script.chmod(0o755)
    out = tmp_path / "fake"
    out.mkdir()
    cfg = tmp_path / "claude-config"
    cfg.mkdir()
    # main runs in the corpus folder, which the analyst trusted when Claude Code first asked
    (cfg / ".claude.json").write_text(json.dumps({"projects": {str(config.corpus_dir(CORPUS)): {"hasTrustDialogAccepted": True}}}))
    monkeypatch.setattr(agent_session, "CLAUDE_BIN", str(script))
    monkeypatch.setenv("FAKE_DIR", str(out))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")
    ledger.put_settings(CORPUS, {"terminal_first": True})
    return out


def _bg_calls(fake: Path) -> list[list[str]]:
    return [a for a in map(json.loads, (fake / "argvs.jsonl").read_text().splitlines()) if "--bg" in a]


def _state(fake: Path) -> dict:
    return json.loads((fake / "sessions.json").read_text())


def _transcript(sid: str) -> Path:
    return Path(session.find_transcript(sid) or "")


async def _until(cond, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.05)


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


def test_names_labels_and_the_route():
    assert [bg_session.name_of(k) for k in ("orient", "writer:report", "writer:slides", "critique:orient")] == [
        "thimble:orient", "thimble:writer", "thimble:writer-slides", "thimble:critic"]
    assert [bg_session.tray_label(k) for k in ("orient", "writer:report", "critique:orient")] == [
        "orientation session", "writing report", "critique"]
    assert bg_session.proxy_type("writer:report") == "thimble:writer" and bg_session.proxy_type("orient") == "thimble:orient"


def test_the_route_follows_the_settings(workspaces_tmp):
    assert not bg_session.wanted(CORPUS, "writer"), "the default route runs every session as claude -p"
    ledger.put_settings(CORPUS, {"terminal_first": True})
    assert bg_session.wanted(CORPUS, "writer") and bg_session.wanted(CORPUS, "critique")
    assert not bg_session.wanted(CORPUS, "orient"), "the orientation runs as main's subagent unless the setting says"
    ledger.put_settings(CORPUS, {bg_session.ORIENT_ROUTE_KEY: bg_session.ROUTE_SESSION})
    assert bg_session.wanted(CORPUS, "orient")
    assert not bg_session.wanted(CORPUS, "check")


def test_the_bg_command_drops_print_flags_and_carries_the_environment_in_settings(tmp_path):
    argv = ["claude", "-p", "--plugin-dir", "/p", "--session-id", "s1", "--output-format", "stream-json", "--verbose",
            "--settings", json.dumps({"env": {"CLAUDE_CODE_EFFORT_LEVEL": "high"}}), "--agent", "writer"]
    out = bg_session.bg_argv(argv, {"THIMBLE_SESSION": "writer:report", "PATH": "/x", "HOME": "/h"}, {"HOME": "/h"},
                             "thimble:writer", "Write it.", tmp_path)
    assert out[:4] == ["claude", "--bg", "-n", "thimble:writer"] and out[-2:] == ["--", "Write it."]
    assert "-p" not in out and "--session-id" not in out and "--output-format" not in out and "--verbose" not in out
    settings = json.loads(out[out.index("--settings") + 1])
    assert settings["env"] == {"THIMBLE_SESSION": "writer:report", "CLAUDE_CODE_EFFORT_LEVEL": "high"}
    long = bg_session.bg_argv(argv, {}, {}, "thimble:writer", "x" * (bg_session.MAX_ARG + 1), tmp_path)
    assert (tmp_path / bg_session.FIRST_MESSAGE_FILE).read_text() == "x" * (bg_session.MAX_ARG + 1)
    assert str(tmp_path / bg_session.FIRST_MESSAGE_FILE) in long[-1]


def test_a_work_folder_under_the_workspaces_is_trusted_and_another_folder_is_left_alone(tmp_path, monkeypatch):
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    (cfg / ".claude.json").write_text(json.dumps({"projects": {}, "numStartups": 3}))
    env = {config.CONFIG_DIR_ENV: str(cfg)}
    work = config.WORKSPACES_DIR / CORPUS / "orient" / "work"
    work.mkdir(parents=True)
    assert bg_session.trust_workspaces(work, env)
    data = json.loads((cfg / ".claude.json").read_text())
    assert data["projects"][str(config.WORKSPACES_DIR.resolve())]["hasTrustDialogAccepted"] is True
    assert data["numStartups"] == 3, "the rest of the file is kept"
    outside = tmp_path.parent / f"{tmp_path.name}-elsewhere"  # the workspaces are the test's tmp folder
    outside.mkdir()
    assert not bg_session.trust_workspaces(outside, env)
    assert str(outside) not in json.loads((cfg / ".claude.json").read_text())["projects"]


async def test_a_writer_runs_as_a_background_session_whose_run_ends_while_the_session_goes_on(fake):
    run = await write_session.start(CORPUS, "report", "Keep it short.")
    assert run.bg
    argv = _bg_calls(fake)[-1]
    assert argv[:3] == ["--bg", "-n", "thimble:writer"] and "-p" not in argv
    e = bg_session.entry(CORPUS, "writer:report")
    assert e is not None and e.short == run.sid[:8] and e.chat == run.chat
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["background"] is True and meta["bg"] == e.short and meta["bg_name"] == "thimble:writer"
    await asyncio.wait_for(run.task, 10)
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done"
    assert [x["delta"] for x in _log(run.chat) if x["type"] == "text"] == ["Wrote the report."]
    assert bg_session.alive(e) and not e.run_open, "the session lives on after its run"
    assert [n["kind"] for n in agent_session._notes(CORPUS)] == [write_session.WRITTEN_KIND], "main hears it once it listens"


async def test_a_turn_the_session_starts_on_its_own_is_the_chat_s_next_run(fake):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    e = bg_session.entry(CORPUS, "writer:report")
    # the analyst types in the session's own terminal: it starts a turn with no run of thimble's
    st = _state(fake)
    st[e.short]["status"] = "busy"
    (fake / "sessions.json").write_text(json.dumps(st))
    with _transcript(e.sid).open("a") as f:
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "Which card is the first one?"}}) + "\n")
    bg_session._ensure_watcher()
    await _until(lambda: agent_session.current(CORPUS, "writer:report") is not None)
    with _transcript(e.sid).open("a") as f:
        f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "The first card counts pages."}]}}) + "\n")
        f.write(json.dumps({"type": "system", "subtype": "turn_duration"}) + "\n")
    st[e.short]["status"] = "idle"
    (fake / "sessions.json").write_text(json.dumps(st))
    await _until(lambda: agent_session.current(CORPUS, "writer:report") is None)
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["run"] == 1 and meta["status"] == "done"
    rows = [(x["type"], x.get("text") or x.get("delta")) for x in _log(run.chat) if x["type"] in ("user", "text")]
    assert rows[-2:] == [("user", "Which card is the first one?"), ("text", "The first card counts pages.")]
    assert len(_bg_calls(fake)) == 1, "a running session is followed in place, never resumed as a copy"


async def test_a_message_waits_for_the_proxy_which_sends_it_once_through_the_relay_hook(fake):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    e = bg_session.entry(CORPUS, "writer:report")
    item = bg_session.deliver(CORPUS, "writer:report", "Add a sentence on dse.", agents.BROWSER)
    text = await bg_session.wait(CORPUS, "thimble:writer", "a0000000000000001")
    assert item["token"] in text and "SendMessage" in text
    got = bg_session.relay_check(CORPUS, Path("/nonexistent"), "thimble:writer", item["token"])
    assert got["allow"] and got["message"] == tools.hint("bg-from-browser", text="Add a sentence on dse.")
    assert not bg_session.relay_check(CORPUS, Path("/nonexistent"), "thimble:writer", item["token"])["allow"], "sent once"
    assert [(x["text"], x["by"]) for x in _log(run.chat) if x["type"] == "user"][-1] == ("Add a sentence on dse.", "browser")
    assert bg_session.relay_check(CORPUS, None, "someone-else", "hi") is None, "a message to anything else is not ours"


async def test_a_message_typed_in_the_proxy_s_view_goes_once_prefixed(fake, tmp_path):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    proxy = tmp_path / "agent-a0000000000000002.jsonl"
    typed = {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "Quote the first sentence.",
                                                  "source_uuid": "u-1", "origin": {"kind": "human"}}}
    proxy.write_text(json.dumps(typed) + "\n")
    got = bg_session.relay_check(CORPUS, proxy, "thimble:writer", "Quote the first sentence.")
    assert got["allow"] and got["message"] == tools.hint("bg-from-terminal", text="Quote the first sentence.")
    again = bg_session.relay_check(CORPUS, proxy, "thimble:writer", "Quote the first sentence.")
    assert not again["allow"] and again["reason"] == "sent already"
    assert [(x["text"], x["by"]) for x in _log(run.chat) if x["type"] == "user"][-1] == ("Quote the first sentence.", "terminal")
    # main's own message to the session goes as it is, and shows in the session's chat as main's
    mine = bg_session.relay_check(CORPUS, None, "thimble:writer", "Which sources did you use?")
    assert mine == {"allow": True, "message": "Which sources did you use?"}
    assert _log(run.chat)[-1]["by"] == agents.MAIN_ID


async def test_the_proxy_waits_for_news_is_kept_going_and_a_second_one_is_told_to_stop(fake, tmp_path):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    e = bg_session.entry(CORPUS, "writer:report")
    first = await bg_session.wait(CORPUS, "thimble:writer", "a0000000000000003")
    assert "finished its task" in first
    quiet = await bg_session.wait(CORPUS, "thimble:writer", "a0000000000000003")
    assert quiet == tools.hint("wait_session-quiet", session="thimble:writer", state="done, idle")
    second = await bg_session.wait(CORPUS, "thimble:writer", "a0000000000000004")
    assert second == tools.hint("wait_session-duplicate", session="thimble:writer")
    path = tmp_path / "agent-a0000000000000003.jsonl"
    path.write_text(json.dumps({"type": "user", "message": {"content": str(bg_session.proxy_file(CORPUS, e.key))}}) + "\n")
    assert bg_session.proxy_stop(CORPUS, "thimble:writer", path, False, "a0000000000000003") == \
        tools.hint("bg-proxy-keep", session="thimble:writer")
    assert bg_session.proxy_stop(CORPUS, "thimble:writer", path, False, "a0000000000000004") is None, "not the owner"
    e.status = "stopped"
    assert bg_session.proxy_stop(CORPUS, "thimble:writer", path, False, "a0000000000000003") is None
    assert tools.hint("wait_session-ended", session="thimble:writer") in await bg_session.wait(CORPUS, "thimble:writer")


async def test_a_session_whose_process_went_away_leaves_its_chat_stopped(fake):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    e = bg_session.entry(CORPUS, "writer:report")
    agents.update_agent(CORPUS, run.chat, status="running")
    st = _state(fake)
    st[e.short]["pid"] = None
    (fake / "sessions.json").write_text(json.dumps(st))
    bg_session._ensure_watcher()
    await _until(lambda: e.status == "stopped")
    assert agents.read_meta(CORPUS, run.chat)["status"] == "stopped"


async def test_a_restart_follows_a_running_session_again(fake):
    run = await write_session.start(CORPUS, "report")
    e = bg_session.entry(CORPUS, "writer:report")
    st = _state(fake)
    st[e.short]["status"] = "busy"
    (fake / "sessions.json").write_text(json.dumps(st))
    with _transcript(e.sid).open("a") as f:
        f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "go on"}}) + "\n")
    await agent_session.shutdown()
    assert agents.read_meta(CORPUS, run.chat)["status"] == "running", "left running for the next server"
    assert _state(fake)[e.short]["pid"], "the session's process outlives the server"
    bg_session._entries.clear()
    bg_session._loaded.clear()
    found = await bg_session.recover()
    assert found == [f"{CORPUS}/thimble:writer"]
    again = agent_session.current(CORPUS, "writer:report")
    assert again is not None and again.chat == run.chat and again.sid == run.sid
    st[e.short]["status"] = "idle"
    (fake / "sessions.json").write_text(json.dumps(st))
    with _transcript(e.sid).open("a") as f:
        f.write(json.dumps({"type": "system", "subtype": "turn_duration"}) + "\n")
    await asyncio.wait_for(again.task, 10)
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done"


async def test_resume_of_a_stopped_session_keeps_its_id(fake):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    e = bg_session.entry(CORPUS, "writer:report")
    bg_session.stop_cli(e.short)
    e.status = "stopped"
    meta = agents.read_meta(CORPUS, run.chat)
    again = await write_session._resume_left(CORPUS, {**meta, "status": "running"}, "Carry on.")
    assert again.sid == run.sid, "a stopped session starts again under its id"
    argv = _bg_calls(fake)[-1]
    assert argv[:3] == ["--bg", "--resume", run.sid] and argv[-1] == "Carry on."
    await asyncio.wait_for(again.task, 10)


async def test_the_terminal_lists_the_agents_and_the_hooks_print_a_start_and_a_finish_line_once(fake):
    run = await write_session.start(CORPUS, "report")
    cwd = str(config.corpus_dir(CORPUS))
    e = bg_session.entry(CORPUS, "writer:report")
    first = await bg_session.agents_route(bg_session.AgentsQuery(cwd=cwd, session="s1", announce=True))
    assert first["rows"][0]["name"] == "thimble:writer" and first["rows"][0]["attach"] == f"claude attach {e.short}"
    assert first["line"].startswith("thimble · ") and "thimble:writer" in first["line"]
    assert f"claude attach {e.short}" in first["announce"] and "runs as a background session" in first["announce"]
    assert (await bg_session.agents_route(bg_session.AgentsQuery(cwd=cwd, session="s1", announce=True)))["announce"] == ""
    await asyncio.wait_for(run.task, 10)
    done = await bg_session.agents_route(bg_session.AgentsQuery(cwd=cwd, session="s1", announce=True))
    assert done["announce"].startswith("thimble:writer finished")
    statusline = await bg_session.agents_route(bg_session.AgentsQuery(cwd=cwd, session="s2"))
    assert statusline["announce"] == "" and "done, idle" in statusline["line"], "the statusline takes no line from the hooks"
    listed = await tools.call(CORPUS, "list_agents", {})
    assert "thimble:writer" in listed.text and "claude attach" in listed.text


def test_the_statusline_is_set_for_terminal_first_and_put_back_after(workspaces_tmp, tmp_path, monkeypatch):
    from app import cc_settings

    monkeypatch.setattr(bg_session, "sync_statusline", bg_session.apply_statusline)  # the suite's stand-in aside
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    corpus = tmp_path / "corpus-copy"
    corpus.mkdir()
    monkeypatch.setattr(config, "corpus_dir", lambda c: corpus)
    local = corpus / ".claude" / "settings.local.json"
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_text(json.dumps({"statusLine": {"type": "command", "command": "my-line"}, "env": {"A": "1"}}))
    try:
        ledger.put_settings(CORPUS, {"terminal_first": True})
        line = json.loads(local.read_text())["statusLine"]
        assert "thimble-agents --statusline --chain my-line" in line["command"], "chained to the analyst's own"
        assert json.loads(local.read_text())["env"] == {"A": "1"}
        ledger.put_settings(CORPUS, {"terminal_first": False})
        assert json.loads(local.read_text())["statusLine"] == {"type": "command", "command": "my-line"}
        assert cc_settings.own_statusline(corpus) == "my-line"
    finally:
        local.unlink(missing_ok=True)


async def test_a_run_whose_session_was_killed_ends_with_resume_which_starts_it_again_under_its_id(fake, monkeypatch):
    monkeypatch.setenv("FAKE_BUSY", "1")
    run = await write_session.start(CORPUS, "report")
    e = bg_session.entry(CORPUS, "writer:report")
    await asyncio.sleep(0.3)
    assert not run.task.done(), "it works"
    st = _state(fake)
    st[e.short]["pid"] = None  # the process is killed mid-turn
    (fake / "sessions.json").write_text(json.dumps(st))
    await asyncio.wait_for(run.task, 10)
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "failed" and meta["alert"]["kind"] == agent_session.STOPPED_ALERT["kind"]
    again = await agent_session.resume_chat(CORPUS, run.chat)
    assert again.sid == run.sid and again.chat == run.chat and again.k == int(meta.get("run") or 0) + 1
    assert _bg_calls(fake)[-1][:3] == ["--bg", "--resume", run.sid]
    assert agents.read_meta(CORPUS, run.chat).get("alert") is None
    await asyncio.wait_for(again.task, 10)
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done"
    with pytest.raises(RuntimeError):
        await agent_session.resume_chat(CORPUS, agents.MAIN_ID)


async def test_main_s_message_to_the_session_s_name_reaches_the_proxy_which_passes_it_on(fake, tmp_path):
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    proxy = tmp_path / "agent-a0000000000000005.jsonl"
    from_main = {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "Which card do you cite first?",
                                                      "source_uuid": "u-2", "origin": {"kind": "coordinator"}}}
    proxy.write_text(json.dumps(from_main) + "\n")
    got = bg_session.relay_check(CORPUS, proxy, "thimble:writer", "Which card do you cite first?")
    assert got["allow"] and got["message"] == tools.hint("bg-from-main", text="Which card do you cite first?")
    assert not bg_session.relay_check(CORPUS, proxy, "thimble:writer", "Which card do you cite first?")["allow"]
    assert [(x["text"], x["by"]) for x in _log(run.chat) if x["type"] == "user"][-1] == ("Which card do you cite first?", "main")


async def test_a_turn_that_ended_at_capacity_is_retried_in_place_with_its_prompt(fake, monkeypatch):
    monkeypatch.setenv("FAKE_REPLY", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
    monkeypatch.setenv(agent_session.RETRY_BASE_ENV, "0.1")
    run = await write_session.start(CORPUS, "report")
    e = bg_session.entry(CORPUS, "writer:report")
    await _until(lambda: any(not i["sent"] for i in e.outbox), 15)
    [item] = [i for i in e.outbox if not i["sent"]]
    assert item["text"] == tools.hint(agent_session.RETRY_PROMPT), "the retry's prompt waits for the proxy to send it"
    assert len(_bg_calls(fake)) == 1, "no second session, no copy"
    got = bg_session.relay_check(CORPUS, Path("/nonexistent"), "thimble:writer", item["token"])
    assert got["allow"] and got["message"] == item["text"]
    st = _state(fake)
    st[e.short]["status"] = "busy"
    (fake / "sessions.json").write_text(json.dumps(st))
    await asyncio.sleep(0.3)
    with _transcript(e.sid).open("a") as f:
        for rec in ({"type": "user", "message": {"role": "user", "content": item["text"]}},
                    {"type": "assistant", "message": {"content": [{"type": "text", "text": "Wrote the report."}]}},
                    {"type": "system", "subtype": "turn_duration"}):
            f.write(json.dumps(rec) + "\n")
    st[e.short]["status"] = "idle"
    (fake / "sessions.json").write_text(json.dumps(st))
    await asyncio.wait_for(run.task, 15)
    assert agents.read_meta(CORPUS, run.chat)["status"] == "done" and run.sid == e.sid


async def test_the_tray_entry_is_no_chat_of_main_s_and_main_s_message_to_it_stays_out_of_main_s_chat(fake, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    run = await write_session.start(CORPUS, "report")
    await asyncio.wait_for(run.task, 10)
    sid, agent, use = "e7b0a1f2-0000-4000-8000-00000000abcd", "a00000000000000a9", "toolu_tray"
    main = tmp_path / f"{sid}.jsonl"
    main.write_text("")
    lv = session.attach(CORPUS, sid, str(config.corpus_dir(CORPUS)), str(main))
    session.tail_once(lv)
    before = len(_log(agents.MAIN_ID))

    def put(*recs: dict) -> None:
        with main.open("a") as f:
            f.write("".join(json.dumps(r) + "\n" for r in recs))
        session.tail_once(lv)

    prompt = str(bg_session.proxy_file(CORPUS, "writer:report"))
    put({"type": "user", "origin": {"kind": "human"}, "message": {"content": "Show the writer."}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": use, "name": "Agent", "input": {
            "subagent_type": "thimble:writer", "description": "writing report", "prompt": prompt, "run_in_background": True}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": use, "content": [
            {"type": "text", "text": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]}]}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "s1", "name": "SendMessage",
                                                       "input": {"to": agent, "message": "Which card first?"}}]}})
    assert not [m for m in agents.list_chats(CORPUS) if m.get("role") == "subagent"], "no agent chat for the tray entry"
    assert agent in bg_session.entry(CORPUS, "writer:report").proxy_agents
    added = _log(agents.MAIN_ID)[before:]
    assert [x["text"] for x in added if x["type"] == "user"] == ["Show the writer."], \
        "main's message to the tray entry is logged by the session's chat, not main's"
