"""The Claude Code sessions thimble starts beside main (agent_session.py, orient_session.py): their launch arguments,
their permissions and their lifetime. The orientation's session gets its agent with --agents and --agent, thimble's own
tools and the plugin's skills in --allowedTools (for a checkout and a release install alike, so they never ask), the
thimble tools it does not keep in --disallowedTools, --permission-mode from the mode Start chose, THIMBLE_SESSION, the
permission hook and the fence in --settings, and nothing that widens the analyst's permissions. Every request reaches
the server through the PermissionRequest hook: Manual waits for the analyst, Bypass grants. One orientation runs at a
time, and stopping it or shutting the server down ends its process group. Its transcript becomes the orientation's chat,
its subagents and workflow agents its steps, and its end tells main in one line what it made.

A stand-in for the CLI (FAKE, run as agent_session.CLAUDE_BIN) records its argv, its environment and what it read on
stdin, and writes what Claude Code writes for such a session: the transcript under the config dir's projects/, a
subagent's transcript with its meta json, a workflow's run directory with its journal.jsonl and agent transcript, and
stream-json on stdout whose last `result` is the summary."""
from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import (agent_session, agents, channel, cli, config, ledger, orient_session, orientation, permission_hook,
                 prompts, session, tools)

CORPUS = "mini"
KEY = orient_session.KEY
MARKETPLACE = "thimble-local"  # scripts/release.sh's default name

SUMMARY = "The corpus is one file, runs.jsonl, with 12 runs [[card:aaaa1111]]."

FAKE = r'''
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
out = Path(os.environ["FAKE_DIR"])
(out / "argv.json").write_text(json.dumps(argv))
(out / "env.json").write_text(json.dumps({k: os.environ.get(k) for k in ("THIMBLE_SESSION", "THIMBLE_CHANNEL", "XDG_CACHE_HOME", "MPLCONFIGDIR",
                                                                        "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "THIMBLE_RENDERED_PROMPTS",
                                                                        "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS")}
                                          | {"PATH0": os.environ.get("PATH", "").split(os.pathsep)[0], "cwd": os.getcwd()}))
with open(out / "argvs.jsonl", "a") as f:
    f.write(json.dumps(argv) + "\n")
resume = "--resume" in argv
sid = argv[argv.index("--resume" if resume else "--session-id") + 1]
brief = sys.stdin.read()
(out / "stdin.txt").write_text(brief)
proj = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-corpus"
proj.mkdir(parents=True, exist_ok=True)
main = proj / f"{sid}.jsonl"
subs = proj / sid / "subagents"
run_dir = subs / "workflows" / "wf_1"
run_dir.mkdir(parents=True, exist_ok=True)
def put(path, *recs):
    with open(path, "a") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")
print(json.dumps({"type": "system", "subtype": "init", "session_id": sid}), flush=True)
calls = sum(1 for _ in open(out / "argvs.jsonl"))
if resume:
    k = calls
    put(main, {"type": "user", "message": {"role": "user", "content": brief}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"b{k}", "name": "Bash", "input": {"command": f"grep -c run{k} runs.jsonl"}}]}})
    time.sleep(float(os.environ.get("FAKE_SLEEP") or 0))
    put(main, {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"b{k}", "content": f"{k}"}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": f"done {k}"}]}})
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": f"done {k}"}), flush=True)
    sys.exit(0)
if os.environ.get("FAKE_MODE") == "sleep":
    put(main, {"type": "user", "message": {"role": "user", "content": brief}})
    time.sleep(60)
    sys.exit(0)
put(main, {"type": "user", "message": {"role": "user", "content": brief}},
    {"type": "assistant", "effort": "high", "message": {"content": [{"type": "tool_use", "id": "t_agent", "name": "Agent",
        "input": {"subagent_type": "general-purpose", "description": "Read runs.jsonl", "prompt": "Read runs.jsonl"}}]}})
put(subs / "agent-a1reader.jsonl",
    {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "Read runs.jsonl"}},
    {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "runs.jsonl"}}]}},
    {"type": "user", "isSidechain": True, "message": {"content": [{"type": "tool_result", "tool_use_id": "r1", "content": "12 lines"}]}},
    {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "12 runs, 3 tasks."}]}})
(subs / "agent-a1reader.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "Read runs.jsonl", "toolUseId": "t_agent"}))
put(main, {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_agent", "content": "12 runs, 3 tasks."}]}},
    {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t_wf", "name": "Workflow", "input": {"script": "export const meta = {name: 'x'}"}}]}},
    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t_wf", "content": f"Workflow launched in background. Task ID: w1\nTranscript dir: {run_dir}\n"}]}})
put(run_dir / "journal.jsonl", {"type": "launched"}, {"type": "started", "agentId": "wa1", "label": "runs", "phase": "Count"})
put(run_dir / "agent-wa1.jsonl",
    {"type": "user", "isSidechain": True, "message": {"role": "user", "content": "Count the runs by task"}},
    {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "4 each."}]}})
put(run_dir / "journal.jsonl", {"type": "result", "agentId": "wa1", "result": "4 each."})
put(main, {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": "<task-notification>\n<task-id>w1</task-id>\n<tool-use-id>t_wf</tool-use-id>\n<status>completed</status>\n</task-notification>"}},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": SUMMARY}]}})
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": SUMMARY}), flush=True)
'''.replace("SUMMARY", json.dumps(SUMMARY))


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp):
    session._live.clear()
    session._expected.clear()
    channel._subs.clear()
    agent_session._runs.clear()
    yield
    channel._subs.clear()
    agent_session._runs.clear()


@pytest.fixture()
def fake(tmp_path, monkeypatch) -> Path:
    """The stand-in CLI as THIMBLE_CLAUDE_BIN, the config dir it writes into, and the folder it records into."""
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
    monkeypatch.setenv("THIMBLE_CHANNEL", "plugin:thimble@inline")  # the server's own, inherited from main's session
    monkeypatch.delenv("FAKE_MODE", raising=False)
    monkeypatch.delenv("FAKE_SLEEP", raising=False)
    monkeypatch.setenv("THIMBLE_SANDBOX", "0")  # the fence without the sandbox; test_the_fence turns it on
    return out


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def _log(chat: str) -> list[dict]:
    return agents.read_events(agents.paths(CORPUS, chat)[1])


async def _done(key: str = orient_session.KEY) -> None:
    run = agent_session._runs.get((CORPUS, key))
    if run is not None and run.task is not None:
        await asyncio.wait_for(run.task, 10)


def _brief(fake: Path) -> str:
    """The first message the session read on stdin."""
    return (fake / "stdin.txt").read_text()


def _agent(fake: Path) -> dict:
    """The orientation's agent as the session was given it with --agents, after checking it is the one --agent names."""
    argv = json.loads((fake / "argv.json").read_text())
    defined = json.loads(argv[argv.index("--agents") + 1])
    assert list(defined) == [orientation.AGENT] and argv[argv.index("--agent") + 1] == orientation.AGENT
    return defined[orientation.AGENT]



def _fenced(**settings) -> dict:
    """The orientation's --settings: the caller's choices, the fence without the sandbox (the fixture turns it off), the
    subagents' scratch folders, the permission hook and the call-ref hooks."""
    work = orient_session.work_dir(CORPUS)
    fence = agent_session.fence(config.corpus_dir(CORPUS), work, sandbox=False)
    fence["permissions"]["ask"] = ["WebFetch", "WebSearch"]  # Manual: the web asks (agent_session, the web)
    return {**settings, **fence, "hooks": {**agent_session.scratch_hooks(work), **agent_session.permission_hooks(CORPUS),
                                           **agent_session.call_hooks(CORPUS)}}


def test_each_subagent_of_a_fenced_session_gets_a_scratch_folder_of_its_own(tmp_path, capsys, monkeypatch):
    """Parallel readers would write the same file names into the one $TMPDIR the sandbox gives a session, so the
    SubagentStart hook makes each subagent `<work>/tmp_<agent id>/`, which the end of a run deletes, and names it in the
    subagent's context with `## session-scratch`."""
    from app import scratch_hook

    [entry] = agent_session.scratch_hooks(tmp_path)["SubagentStart"]
    assert entry["matcher"] == "*" and "scratch_hook.py" in entry["hooks"][0]["command"]
    text = tools.hint(agent_session.SCRATCH_PROMPT, folder="{folder}")
    assert "{folder}" in text and "$TMPDIR" in text
    for agent in ("a1b2c3", "a9"):
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"hook_event_name": "SubagentStart", "agent_id": agent})))
        assert scratch_hook.main(["--work", str(tmp_path), "--text", text]) == 0
        out = json.loads(capsys.readouterr().out)["hookSpecificOutput"]
        assert out == {"hookEventName": "SubagentStart", "additionalContext": text.replace("{folder}", str(tmp_path / f"tmp_{agent}"))}
    assert sorted(p.name for p in tmp_path.iterdir()) == ["tmp_a1b2c3", "tmp_a9"]
    assert sorted(p.name for p in tmp_path.glob(orient_session.TEMP_GLOB)) == ["tmp_a1b2c3", "tmp_a9"], "a run's end deletes them"
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"hook_event_name": "SubagentStart", "agent_id": "../x"})))
    scratch_hook.main(["--work", str(tmp_path), "--text", text])
    assert "tmp_x" in capsys.readouterr().out and not (tmp_path.parent / "x").exists(), "an id is a folder name, never a path"


def _disallowed(fake: Path) -> list[str]:
    argv = json.loads((fake / "argv.json").read_text())
    i = argv.index("--disallowedTools") + 1
    out = []
    while i < len(argv) and not argv[i].startswith("--"):
        out.append(argv[i])
        i += 1
    return out


def _parts(prompt: str) -> set[str]:
    """The keys of orient_session.PARTS whose `#### ` part the prompt holds, and of LINES whose line it holds."""
    return ({k for k, h in orient_session.PARTS.items() if f"\n#### {h}\n" in prompt}
            | {k for k, s in orient_session.LINES.items() if s in prompt})


async def test_start_orientation_starts_the_session_with_start_s_choices_and_mirrors_its_steps_then_main_hears_what_it_made(fake):
    q = _listen()
    channel.post(CORPUS, "start", {"text": "the runs", "critique": False, "ultracode": False, "effort": "high"})
    q.get_nowait()
    res = await tools.call(CORPUS, "start_orientation", {"brief": "the runs", "final_notebook": True, "propose_views": True,
                                                        "generate_report": False})
    assert not res.is_error and tools.hint("start_orientation-started") in res.text
    await _done()

    argv = json.loads((fake / "argv.json").read_text())
    agent = _agent(fake)
    assert argv[0] == "-p" and argv[argv.index("--agent") + 1] == "thimble-orient"
    front, _ = prompts.agent_file("orient")
    # no tools named, so the session has every tool (Bash, skills, the web, the analyst's plugins); the ones it does not
    # get are disallowed: the thimble tools that are not the orientation's, and the critique Start turned off
    assert "tools" not in front and "tools" not in agent
    denied = _disallowed(fake)
    assert {agent_session.thimble_tool("critique"), agent_session.thimble_tool("start_orientation"),
            agent_session.thimble_tool("message_orientation"), agent_session.thimble_tool("write_document")} <= set(denied)
    assert agent_session.thimble_tool("propose_view") not in denied, "the views are on, so propose_view stays"
    assert not any(t in denied for t in ("Bash", "Skill", "Read", "WebFetch", "WebSearch", agent_session.thimble_tool("add_card")))
    i = argv.index("--allowedTools") + 1
    given = argv[i:argv.index("--disallowedTools")]
    assert given == agent_session.own_rules(), \
        "thimble's tools, as main's launcher allows main's, and the plugin's skills, each without a prompt"
    assert agent_session.own_rules() == ["mcp__plugin_thimble_thimble", *cli.skill_rules(agent_session.PLUGIN_DIR)]
    assert "model" not in agent and "skills" not in agent
    assert agent["prompt"] == orient_session.system_prompt(CORPUS, "the runs", ["final", "views"])
    assert argv[argv.index("--effort") + 1] == "high"
    # the orient role's fast mode (on by default, since the analyst's settings here name none) and its model, Opus 5.5
    # when the analyst's settings name none, with its 1M-token window, which its subagents take without the window; the
    # fence that keeps the corpus folder read-only and its writes in its work folder, and the call-ref hook
    assert json.loads(argv[argv.index("--settings") + 1]) == _fenced(
        ultracode=False, fastMode=True, env={"CLAUDE_CODE_SUBAGENT_MODEL": "claude-opus-5-5", "CLAUDE_CODE_EFFORT_LEVEL": "high"})
    assert argv[argv.index("--model") + 1] == "claude-opus-5-5[1m]"
    assert "--permission-prompt-tool" not in argv, "its permission hook asks (agent_session, permissions)"
    assert argv[argv.index("--permission-mode") + 1] == "default", "Manual, which the analyst's own mode stands for"
    for flag in ("--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"):
        assert flag not in argv, "never a bypass of Claude Code's own"
    assert "bypassPermissions" not in " ".join(argv)
    assert "--" not in argv and _brief(fake) == tools.hint("orient-start"), "a fixed first line on stdin"
    # the title and one paragraph, shared.md in place, then the orientation's own section, which opens with the
    # analyst's request and then the guidelines; the critique Start turned off and the report nobody asked for
    # are left out
    prompt = agent["prompt"]
    shared = channel.render_prompts(("shared",), str(config.corpus_dir(CORPUS)))
    assert "--append-system-prompt" not in argv, "shared.md is in the prompt once, in place"
    assert prompt.startswith("# Orientation\n\n") and shared in prompt
    assert prompt.index("You are the orientation") < prompt.index(shared) < prompt.index("## The orientation")
    assert "### The analyst's request\n\nthe runs\n\n### A good analysis" in prompt
    assert _parts(prompt) == {"final", "views"} and "{{" not in prompt and "\n\n\n" not in prompt
    cache = orient_session.work_dir(CORPUS) / agent_session.CACHE_DIR
    # the process runs in the work folder with the corpus folder added, so the whole corpus folder can be denied to
    # Bash (agent_session, the fence), the corpus's CLAUDE.md is read as the added folder's, and the shared skill's
    # command prints the prompts rendered into the work folder, since the sandbox hides thimble's tree from it
    assert json.loads((fake / "env.json").read_text()) == {"THIMBLE_SESSION": "orient", "THIMBLE_CHANNEL": None,
                                                           "XDG_CACHE_HOME": str(cache), "MPLCONFIGDIR": str(cache / "matplotlib"),
                                                           "PATH0": str(Path(sys.prefix) / "bin"),
                                                           "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
                                                           "THIMBLE_RENDERED_PROMPTS": str(orient_session.work_dir(CORPUS) / agent_session.RENDERED_DIR),
                                                           agent_session.BG_WAIT_ENV: agent_session.BG_WAIT_MS,
                                                           "cwd": str(orient_session.work_dir(CORPUS))}
    assert argv[argv.index("--add-dir") + 1] == str(config.corpus_dir(CORPUS)) and argv[argv.index("--add-dir") + 2].startswith("--")

    chat = next(m for m in agents.list_chats(CORPUS) if m.get("role") == orientation.ROLE)
    assert (chat["title"], chat["status"], chat["parent"]) == ("Orientation", "done", agents.MAIN_ID)
    recs = _log(chat["id"])
    assert recs[0] == {**recs[0], "type": "user", "text": tools.hint("orient-start")}
    assert chat["brief"] == "the runs", "the orientation's card shows the analyst's instructions"
    from app import calls

    uses = [r for r in recs if r["type"] == "tool_use"]
    assert [r["name"] for r in uses] == ["Agent", "Workflow"]
    read = ({1, 2, 3} - {r["n"] for r in uses}).pop()  # one sequence over the session and its agents
    assert calls.get(CORPUS, chat["id"], read)["name"] == "Read" and calls.get(CORPUS, chat["id"], read)["result"] == "12 lines"
    assert any(r["type"] == "text" and r["delta"] == SUMMARY for r in recs)
    steps = sorted((m for m in agents.list_chats(CORPUS) if m.get("parent") == chat["id"]), key=lambda m: m["created_at"])
    assert [(m["role"], m["title"], m["status"]) for m in steps] == [("step", "Read runs.jsonl", "done"), ("step", "Count: runs", "done")]
    assert [r["type"] for r in _log(chat["id"]) if r["type"] == "agent"] == ["agent", "agent"], "the steps are announced in the orientation's chat"
    reader = _log(steps[0]["id"])
    assert (reader[0]["type"], reader[0]["text"]) == ("user", "Read runs.jsonl") and any(r.get("name") == "Read" for r in reader)
    assert [r.get("text") or r.get("delta") for r in _log(steps[1]["id"]) if r["type"] in ("user", "text")] == ["Count the runs by task", "4 each."]

    run = orientation.read_run(CORPUS)
    assert run["status"] == "done" and run["chats"] == {"orient": chat["id"]} and run["session"] == chat["session"]
    assert orientation.summary(CORPUS).strip() == SUMMARY, "the last message is kept as the record"
    heard = q.get_nowait()
    # the orientation's outputs are in the canvas: main hears a line counting what the orientation made, never its last
    # message
    made = ", ".join([tools.hint("orient-made-views", views="no views"), "no cards"])
    assert heard["meta"]["kind"] == orientation.ORIENT_KIND and heard["meta"]["status"] == "done"
    assert heard["content"] == tools.hint("orient-finished", made=made) and SUMMARY not in heard["content"]
    assert not orient_session.running(CORPUS)


def test_the_end_line_counts_the_orientation_s_own_views_by_where_their_builds_stand(monkeypatch):
    """The end line counts the orientation's own proposals since it started, built, failed or still building; one it
    dropped because it could not be built (views.drop) is not counted, and neither is one the analyst asked main for."""
    from app import views

    rows = [
        {"slug": "old", "name": "Old", "status": "built", "ts": "2026-09-24T00:00:00+00:00"},
        {"slug": "grid", "name": "Grid", "status": "built", "ts": "2026-09-25T10:01:00+00:00"},
        {"slug": "tree", "name": "Tree", "status": "failed", "ts": "2026-09-25T10:02:00+00:00"},
        {"slug": "map", "name": "Map", "status": "queued", "ts": "2026-09-25T10:03:00+00:00"},
        {"slug": "list", "name": "List", "status": "building", "ts": "2026-09-25T10:04:00+00:00"},
        {"slug": "mine", "name": "Mine", "status": "failed", "asked": True, "ts": "2026-09-25T10:05:00+00:00"},
        {"slug": "gone", "name": "Gone", "status": "dropped", "ts": "2026-09-25T10:06:00+00:00"}]
    monkeypatch.setattr(views, "list_proposals", lambda c: rows)  # each row as its build left it
    run = {"started": "2026-09-25T10:00:00+00:00", "passes": ["views"]}
    assert orient_session.view_counts(CORPUS, orient_session._at(run["started"])) == {"built": 1, "failed": 1, "building": 2}
    assert orient_session.made_text(CORPUS, run) == ", ".join(
        [tools.hint("orient-views-built", views="1 view"), tools.hint("orient-views-failed", views="1 view"),
         tools.hint("orient-views-building", views="2 views")])
    counts = orient_session.view_counts(CORPUS, orient_session._at("2026-09-26T00:00:00+00:00"))
    assert orient_session.views_text(counts) == tools.hint("orient-made-views", views="no views")
    line = orient_session.status_text(CORPUS, "done", k=1, made={"views": 2, "view_states": {"built": 2}})
    assert tools.hint("orient-views-built", views="2 views") in line, "a follow-up's line counts the same way"


async def test_a_second_orient_while_one_runs_is_refused_and_the_browser_can_stop_it(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    q = _listen()
    await orient_session.start(CORPUS, "")
    await asyncio.sleep(0.3)
    res = await tools.call(CORPUS, "start_orientation", {"brief": "again"})
    assert res.is_error and tools.hint("start_orientation-running") in res.text
    run = orient_session.current(CORPUS)
    pid = run.pid
    # the browser's Stop is its chat's interrupt, which stops the session's process group
    assert (await agents.interrupt_route(CORPUS, run.chat))["stopped"] is True
    await _done()
    with pytest.raises(ProcessLookupError):
        os.killpg(pid, 0)  # the process group is gone, and the agents in it with it
    chat = agents.read_meta(CORPUS, run.chat)
    assert chat["status"] == "stopped" and orientation.read_run(CORPUS)["status"] == "stopped"
    heard = q.get_nowait()
    made = ", ".join([tools.hint("orient-made-views", views="no views"), "no cards"])
    assert heard["meta"]["status"] == "stopped" and heard["content"] == tools.hint("orient-stopped", made=made), "no exit code for main"
    assert not await orient_session.stop(CORPUS), "nothing runs any more"


async def test_the_server_s_shutdown_stops_the_session_and_a_run_whose_process_is_gone_is_not_active(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    await asyncio.sleep(0.2)
    assert orientation.active(CORPUS)
    await agent_session.shutdown()
    # its process ended, its chat and record left running for the next server to resume (agent_session, restart)
    meta = agents.read_meta(CORPUS, run.chat)
    assert meta["status"] == "running" and meta["pid"] is None and not meta.get("result")
    assert run.proc.returncode is not None and not orient_session.running(CORPUS)
    # its record says running while its process is gone, which neither active nor running takes for a run going
    assert orientation.read_run(CORPUS)["status"] == "running"
    assert not orientation.active(CORPUS) and not orientation.running(CORPUS), "the next orient is not refused"


async def _settled() -> None:
    """Every run of the orientation has ended and none waits to start."""
    await asyncio.sleep(0.1)
    for _ in range(200):
        await _done()
        if not orient_session.running(CORPUS) and not (orientation.read_run(CORPUS) or {}).get("queue"):
            await asyncio.sleep(0.1)
            if not orient_session.running(CORPUS):
                return
        await asyncio.sleep(0.05)
    raise AssertionError("the orientation did not settle")


async def test_start_s_mode_becomes_the_session_s_permission_mode(fake, monkeypatch):
    """Start's mode switcher is Claude Code's (manual | auto | bypass). Start's mode for the orientation alone decides its --permission-mode, whatever the analyst's mode is, and is kept for the
    follow-ups; the switcher opens on the analyst's own mode. Auto is Claude Code's auto mode; Manual and Bypass are
    both its manual mode, since thimble grants each request in Bypass (agent_session, permissions)."""
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "auto"})
    assert orientation.read_run(CORPUS)["permissions"] == "auto"
    await tools.call(CORPUS, "start_orientation", {"brief": ""})
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--permission-mode") + 1] == "auto"
    assert orientation.read_run(CORPUS)["permissions"] == "auto", "kept, so a follow-up runs the same way"
    await orient_session.message(CORPUS, "more", orient_session.MAIN)
    await _settled()
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--permission-mode") + 1] == "auto"
    agent_session._runs.clear()
    channel.post(CORPUS, "start", {"text": "", "permissions": "manual"})
    await tools.call(CORPUS, "start_orientation", {"brief": ""})
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--permission-mode") + 1] == "default", "Manual is Claude Code's default mode, passed as such"
    settings = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
    assert ledger.get_settings(CORPUS)["orient_permissions"] == "bypass", "the switcher opens on the analyst's own mode"
    settings.write_text(json.dumps({"permissions": {"defaultMode": "default"}}))
    agent_session._runs.clear()
    channel.post(CORPUS, "start", {"text": "", "permissions": "bypass"})
    await tools.call(CORPUS, "start_orientation", {"brief": ""})
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--permission-mode") + 1] == "default", "Bypass runs in manual mode, thimble granting each request"
    assert orientation.read_run(CORPUS)["permissions"] == "bypass"


async def test_manual_lets_the_orientation_load_the_plugin_s_own_skills_without_a_permission_request(fake):
    """In Manual the orientation's Skill call for `thimble:shared` must not wait on the browser. Each of the plugin's
    skills is allowed by its exact name, and no other skill is: a prefix rule such as `Skill(thimble:*)` would also match any skill whose
    name starts with "thimble"."""
    rules = [r for r in agent_session.own_rules() if r.startswith("Skill")]
    assert "Skill(thimble:shared)" in rules
    skills = sorted(d.name for d in (agent_session.PLUGIN_DIR / "skills").iterdir() if (d / "SKILL.md").is_file())
    assert rules == [f"Skill(thimble:{n})" for n in skills]
    assert not any(r.endswith("*)") or r == "Skill" for r in rules), "only thimble's own skills, each by name"
    settings = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "manual"})
    await tools.call(CORPUS, "start_orientation", {"brief": "", "final_notebook": False, "propose_views": False,
                                                  "generate_report": False})
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--permission-mode") + 1] == "default"
    given = argv[argv.index("--allowedTools") + 1:argv.index("--disallowedTools")]
    assert "Skill(thimble:shared)" in given, "the shared skill loads without asking, even with every output off"
    assert "Skill" not in _disallowed(fake)


# ----------------------------------------------------------------------------- how a session asks for permission


async def _pending(chat: str, n: int = 1) -> list[dict]:
    """The chat's pending permission requests once it has `n`."""
    for _ in range(200):
        ps = agents.read_meta(CORPUS, chat).get("permissions") or []
        if len(ps) >= n:
            return ps
        await asyncio.sleep(0.02)
    raise AssertionError(f"fewer than {n} requests on the chat")


def _ask(tool: str, inp: dict, agent_id: str | None = None, key: str = KEY) -> "asyncio.Future":
    return asyncio.ensure_future(agent_session.ask(CORPUS, key, tool, inp, agent_id=agent_id))


def _flag(argv: list[str]) -> str:
    return argv[argv.index("--permission-mode") + 1]


async def test_every_session_asks_through_the_permission_hook_and_no_prompt_tool(fake):
    """The settings of every session carry the permission hook for PermissionRequest and PermissionDenied (a
    --permission-prompt-tool never hears a background agent's request), with a day to wait, told the workspace."""
    run = await orient_session.start(CORPUS, "")
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert "--permission-prompt-tool" not in argv
    hooks = json.loads(argv[argv.index("--settings") + 1])["hooks"]["PermissionRequest"]
    [hook] = hooks[0]["hooks"]
    assert hooks[0]["matcher"] == "*" and hook["timeout"] == permission_hook.TIMEOUT == 86_400
    assert "permission_hook.py" in hook["command"] and hook["command"].endswith(f"--ws {CORPUS}")
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert settings["hooks"]["PermissionDenied"] == hooks and "PreToolUse" not in settings["hooks"]
    assert run.mode == "manual" and _flag(argv) == "default", "no Start and no mode of the analyst's: Manual"
    assert "ask_permission" not in tools.REGISTRY


async def test_manual_waits_for_the_analyst_however_long_while_a_writer_s_request_is_denied_after_a_minute(fake, monkeypatch):
    """Manual is Claude Code's manual mode: each request it makes waits on the orientation's card, with the agent that
    asked, until the analyst answers, with no minute's deny. A writer, which runs in the analyst's own mode, keeps the minute."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    monkeypatch.setattr(agent_session, "PERMISSION_WAIT_S", 0.05)
    run = await orient_session.start(CORPUS, "")
    assert run.patient and agents.read_meta(CORPUS, run.chat)["permission_mode"] == "manual"
    inp = {"command": "touch notes.md", "description": "Create notes.md"}
    call = _ask("Bash", inp, agent_id="a1")
    [p] = await _pending(run.chat)
    assert (p["tool"], p["what"], p["agent_id"]) == ("Bash", "Create notes.md", "a1") and "touch notes.md" in p["input"]
    await asyncio.sleep(0.3)
    assert not call.done(), "no time limit in Manual"
    assert (await agent_session.permission_route(CORPUS, run.chat, agent_session.PermissionAnswer(id=p["id"], allow=True)))["allow"]
    assert await call == {"behavior": "allow", "updatedInput": inp}
    call = _ask("Write", {"file_path": "x"})
    [p] = await _pending(run.chat)
    agent_session.answer(CORPUS, run.chat, p["id"], False)
    assert await call == {"behavior": "deny", "message": agent_session.DENIED_LINE}
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert [(r["event"], r.get("tool"), r.get("answer")) for r in log] == [
        ("asked", "Bash", None), ("answered", None, "allow"), ("asked", "Write", None), ("answered", None, "deny")]
    assert log[0]["agent_id"] == "a1" and log[0]["chat"] == run.chat and log[0]["session"] == KEY and log[0]["mode"] == "manual"
    assert await agent_session.ask(CORPUS, "writer:report", "Bash", inp) == {"behavior": "deny", "message": agent_session.GONE_LINE}
    await orient_session.stop(CORPUS)
    await _done()
    run = agent_session.Run(CORPUS, "writer:report", "w1", "sid-w", Path("."), "writer", pid=1)
    agent_session._runs[(CORPUS, run.key)] = run
    try:
        run.chat = str(agents.new_agent(CORPUS, "writer", "Write report")["id"])
        assert not run.patient
        assert await agent_session.ask(CORPUS, run.key, "Bash", inp) == {
            "behavior": "deny", "message": agent_session.timed_out_line(0.05)}
        last = json.loads((config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()[-1])
        assert last["answer"] == "deny: nobody answered in time" and last["chat"] == run.chat
        [expired] = agents.read_meta(CORPUS, run.chat)["permissions"]
        assert expired["expired"] and expired["tool"] == "Bash", "it stays on the card, marked denied unanswered"
        assert agent_session.answer(CORPUS, run.chat, expired["id"], False), "Dismiss takes it off"
        assert agents.read_meta(CORPUS, run.chat)["permissions"] == []
        assert agent_session.timed_out_line(60).startswith("Nobody answered in thimble's browser within a minute,")
        assert "within 10 minutes," in agent_session.timed_out_line(600)
    finally:
        agent_session._runs.pop((CORPUS, run.key), None)


async def test_bypass_grants_every_request_and_switches_with_manual_while_the_session_runs(fake, monkeypatch):
    """Bypass never asks and runs in Claude Code's manual mode, so the card switches it with Manual on the same
    process: a switch to Bypass grants what waits, the critique's included, and after a switch back the next request
    waits again. The record keeps the mode for a follow-up."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    _listen()
    channel.post(CORPUS, "start", {"text": "", "permissions": "bypass"})
    run = await orient_session.start(CORPUS, "")
    pid = run.pid
    assert run.mode == "bypass" and _flag(run.argv) == "default"
    assert agents.read_meta(CORPUS, run.chat)["permission_mode"] == "bypass"
    assert await agent_session.ask(CORPUS, KEY, "Bash", {"command": "rm -r out"}) == {"behavior": "allow",
                                                                                   "updatedInput": {"command": "rm -r out"}}
    assert not agents.read_meta(CORPUS, run.chat).get("permissions"), "nothing reached the card"
    assert agent_session.set_mode(CORPUS, run.chat, "manual") == {"mode": "manual", "switching": None}
    assert orientation.read_run(CORPUS)["permissions"] == "manual"
    call = _ask("Bash", {"command": "rm -r out"})
    # the critique follows the orientation's mode at each request
    critic = agent_session.Run(CORPUS, "critique:orient", "", "sid-c", Path("."), "step", pid=1, mode="manual", mode_owner=KEY, patient=True)
    critic.chat = str(agents.new_agent(CORPUS, "step", "critique", parent=run.chat)["id"])
    agent_session._runs[(CORPUS, critic.key)] = critic
    try:
        asked = _ask("Read", {"file_path": "/etc/hosts"}, key=critic.key)
        await _pending(run.chat)
        await _pending(critic.chat)
        assert agent_session.set_mode(CORPUS, run.chat, "bypass") == {"mode": "bypass", "switching": None}
        assert (await call)["behavior"] == "allow" and (await asked)["behavior"] == "allow", "what waited is granted"
        assert run.pid == pid and _flag(run.argv) == "default", "the same process"
        assert agents.read_meta(CORPUS, run.chat)["permission_mode"] == "bypass"
        with pytest.raises(HTTPException) as e:
            await agent_session.mode_route(CORPUS, critic.chat, agent_session.ModeBody(mode="auto"))
        assert e.value.status_code == 409, "the critique has no mode of its own"
    finally:
        agent_session._runs.pop((CORPUS, critic.key), None)
    with pytest.raises(HTTPException) as e:
        await agent_session.mode_route(CORPUS, run.chat, agent_session.ModeBody(mode="yolo"))
    assert e.value.status_code == 400
    await orient_session.stop(CORPUS)
    await _done()
    with pytest.raises(HTTPException) as e:
        await agent_session.mode_route(CORPUS, run.chat, agent_session.ModeBody(mode="manual"))
    assert e.value.status_code == 404


RULE = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test *"}], "behavior": "allow",
        "destination": "localSettings"}
EDITS = {"type": "setMode", "mode": "acceptEdits", "destination": "session"}


def test_the_card_offers_claude_code_s_own_don_t_ask_again_for_the_session_alone():
    """offer keeps a request's allow rules, working directories and a switch to acceptEdits, each for the session only
    (thimble writes no settings file), and leaves out a deny rule and any other mode; offer_text names them as Claude
    Code's settings do."""
    offered = agent_session.offer([RULE, EDITS, {"type": "addDirectories", "directories": ["/tmp/out"], "destination": "localSettings"},
                                   {"type": "setMode", "mode": "bypassPermissions", "destination": "session"},
                                   {**RULE, "behavior": "deny"}, "junk"])
    assert offered == [{**RULE, "destination": "session"}, EDITS,
                       {"type": "addDirectories", "directories": ["/tmp/out"], "destination": "session"}]
    assert agent_session.offer_text(offered) == "Bash(npm test *), files in out/, all edits"
    assert agent_session.offer_text(agent_session.offer([{**RULE, "rules": [{"toolName": "WebSearch"}]}])) == "WebSearch"
    assert agent_session.offer(None) == agent_session.offer([{"type": "setMode", "mode": "plan"}]) == []


async def test_don_t_ask_again_allows_the_request_with_its_rules_and_every_later_process_keeps_them(fake, monkeypatch):
    """The card's third choice allows the request with the updates Claude Code suggested for it (as
    `updatedPermissions`, which the session applies to itself and its agents), allows each other waiting request it
    suggested the same updates for, lists what was added on the chat, and puts it in the argv each later process
    starts with, since Claude Code keeps a session's rules in memory only. A resumed start of the chat keeps them."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    one = asyncio.ensure_future(agent_session.ask(CORPUS, KEY, "Bash", {"command": "npm test -- a"}, suggestions=[RULE]))
    two = asyncio.ensure_future(agent_session.ask(CORPUS, KEY, "Bash", {"command": "npm test -- b"}, suggestions=[RULE]))
    other = asyncio.ensure_future(agent_session.ask(CORPUS, KEY, "Bash", {"command": "make"}))
    first, second, third = await _pending(run.chat, 3)
    assert first["always"] == "Bash(npm test *)" and first["command"] == "npm test -- a" and "always" not in third
    assert agent_session.answer(CORPUS, run.chat, third["id"], True, always=True)  # nothing offered: a plain allow
    assert await other == {"behavior": "allow", "updatedInput": {"command": "make"}}
    assert (await agent_session.permission_route(CORPUS, run.chat, agent_session.PermissionAnswer(id=first["id"], allow=True, always=True)))["allow"]
    assert await one == {"behavior": "allow", "updatedInput": {"command": "npm test -- a"},
                         "updatedPermissions": [{**RULE, "destination": "session"}]}
    assert await two == {"behavior": "allow", "updatedInput": {"command": "npm test -- b"}}, "the same rule covers it"
    assert agents.read_meta(CORPUS, run.chat)[agent_session.RULES_KEY] == [
        {"text": "Bash(npm test *)", "update": {**RULE, "destination": "session"}}]
    assert "Bash(npm test *)" in json.loads(run.argv[run.argv.index("--settings") + 1])["permissions"]["allow"]
    edit = asyncio.ensure_future(agent_session.ask(CORPUS, KEY, "Write", {"file_path": "notes.md"}, suggestions=[EDITS]))
    [p] = await _pending(run.chat)
    assert p["always"] == "all edits" and "command" not in p
    agent_session.answer(CORPUS, run.chat, p["id"], True, always=True)
    assert (await edit)["updatedPermissions"] == [EDITS]
    assert _flag(run.argv) == "acceptEdits", "a later process starts with all edits allowed"
    assert agent_session.set_mode(CORPUS, run.chat, "bypass")["mode"] == "bypass"
    assert agent_session.set_mode(CORPUS, run.chat, "manual")["mode"] == "manual"
    assert _flag(run.argv) == "acceptEdits", "a switch between Manual and Bypass keeps it"
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    assert "allow, don't ask again: Bash(npm test *)" in [r.get("answer") for r in log]
    assert "allow: covered by a rule added for this session" in [r.get("answer") for r in log]
    await orient_session.stop(CORPUS)
    await _done()
    assert agent_session.kept_rules(CORPUS, run.chat) == [{**RULE, "destination": "session"}, EDITS]
    argv = agent_session.with_rules(["claude", "--settings", json.dumps({"permissions": {"allow": ["Read"]}}),
                                     "--permission-mode", "auto"], agent_session.kept_rules(CORPUS, run.chat), Path("."))
    assert json.loads(argv[2])["permissions"]["allow"] == ["Read", "Bash(npm test *)"] and argv[-1] == "auto", \
        "auto mode stays auto mode"


async def test_a_request_names_the_step_that_asks(fake, monkeypatch, tmp_path):
    """A subagent's or workflow agent's request carries the hook's agent type and the title and chat of its step."""
    monkeypatch.setenv("FAKE_MODE", "sleep")
    run = await orient_session.start(CORPUS, "")
    sub = agent_session._new_step(run, "a1", "Read runs.jsonl", tmp_path / "agent-a1.jsonl", agent_type="general-purpose")
    call = _ask("Read", {"file_path": "runs.jsonl"}, agent_id="a1")
    asyncio.ensure_future(agent_session.ask(CORPUS, KEY, "Bash", {"command": "ls"}, agent_id="a9", agent_type="Explore"))
    named, unknown = await _pending(run.chat, 2)
    assert (named["agent_id"], named["agent_title"], named["agent_chat"]) == ("a1", "Read runs.jsonl", sub.chat)
    assert (unknown["agent_type"], unknown.get("agent_title")) == ("Explore", None)
    agent_session.answer(CORPUS, run.chat, named["id"], True)
    assert (await call)["behavior"] == "allow"
    await orient_session.stop(CORPUS)
    await _done()


def test_the_permission_hook_hands_the_request_to_the_server_and_prints_its_decision(monkeypatch, capsys):
    sent: list[tuple[str, dict]] = []

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    answer = {"behavior": "deny", "message": "Denied from thimble's browser."}

    def urlopen(req, timeout=None):
        sent.append((req.full_url, json.loads(req.data)))
        assert timeout == permission_hook.TIMEOUT
        return Resp(json.dumps(answer).encode())

    monkeypatch.setattr(permission_hook.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(permission_hook, "server_url", lambda: "http://127.0.0.1:8311")
    monkeypatch.setenv("THIMBLE_SESSION", KEY)
    hook = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"},
            "agent_id": "a1", "agent_type": "general-purpose", "session_id": "sid"}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0
    assert sent == [("http://127.0.0.1:8311/api/ws/mini/sessions/permission",
                     {"session": KEY, "event": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"},
                      "agent_id": "a1", "agent_type": "general-purpose"})]
    assert json.loads(capsys.readouterr().out) == {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                                                          "decision": answer}}
    answer = {"behavior": "allow", "updatedInput": {"command": "ls"}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    permission_hook.main(["--ws", CORPUS])
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow"}
    # Claude Code's "don't ask again" choices go to the server, and the ones the analyst chose come back in the decision
    updates = [{**RULE, "destination": "session"}]
    answer = {"behavior": "allow", "updatedInput": {"command": "ls"}, "updatedPermissions": updates}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({**hook, "permission_suggestions": [RULE]})))
    permission_hook.main(["--ws", CORPUS])
    assert sent[-1][1]["suggestions"] == [RULE]
    assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]["decision"] == {"behavior": "allow",
                                                                                     "updatedPermissions": updates}

    def down(req, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(permission_hook.urllib.request, "urlopen", down)
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "no server: no decision"
    monkeypatch.delenv("THIMBLE_SESSION")
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(hook)))
    assert permission_hook.main(["--ws", CORPUS]) == 0 and capsys.readouterr().out == "", "not a session thimble started"


# ----------------------------------------------------------------------------- thimble's own tools never ask, in any install


@pytest.fixture(params=["checkout", "release"])
def install(request, fake, tmp_path, monkeypatch) -> SimpleNamespace:
    """The plugin copy a session thimble starts loads (`session`) and the one main runs from (`main`), for each install
    kind. A release: the plugin in $THIMBLE_HOME/app/plugin beside the marketplace file release.sh writes, registered
    and enabled in Claude Code's settings as thimble@thimble-local, whose installed copy in the plugin cache is main's,
    which its launcher exports as THIMBLE_PLUGIN_ROOT (cli.plugin_root)."""
    if request.param == "checkout":
        monkeypatch.delenv(cli.PLUGIN_ROOT_ENV, raising=False)
        return SimpleNamespace(session=agent_session.PLUGIN_DIR, main=cli.PLUGIN_DIR)
    app = tmp_path / "thimble-home" / "app"
    shutil.copytree(config.REPO_ROOT / "plugin", app / "plugin", ignore=shutil.ignore_patterns("__pycache__"))
    (app / ".claude-plugin").mkdir(parents=True)
    (app / ".claude-plugin" / "marketplace.json").write_text(json.dumps(
        {"name": MARKETPLACE, "plugins": [{"name": "thimble", "source": "./plugin"}]}))
    conf = Path(os.environ["CLAUDE_CONFIG_DIR"])
    version = json.loads((app / "plugin" / ".claude-plugin" / "plugin.json").read_text())["version"]
    cached = conf / "plugins" / "cache" / MARKETPLACE / "thimble" / version
    shutil.copytree(app / "plugin", cached)
    conf.mkdir(parents=True, exist_ok=True)
    (conf / "settings.json").write_text(json.dumps({
        "enabledPlugins": {f"thimble@{MARKETPLACE}": True},
        "extraKnownMarketplaces": {MARKETPLACE: {"source": {"source": "directory", "path": str(app)}}}}))
    monkeypatch.setattr(agent_session, "PLUGIN_DIR", app / "plugin")
    monkeypatch.setenv(cli.PLUGIN_ROOT_ENV, str(cached))
    return SimpleNamespace(session=app / "plugin", main=cached)


def model_names(plugin: Path) -> dict[str, str]:
    """Each tool of the plugin's thimble server by its registry name, as the model of a session that loads `plugin`
    calls it: Claude Code names a plugin's MCP tool from the manifest's name and the server's key in its .mcp.json."""
    name = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())["name"]
    [server] = json.loads((plugin / ".mcp.json").read_text())["mcpServers"]
    return {t: f"mcp__plugin_{name}_{server}__{t}" for t in tools.REGISTRY}


def skill_names(plugin: Path) -> list[str]:
    """The plugin's own skills as a Skill call names them, `<plugin>:<skill>`, in a permission rule."""
    name = json.loads((plugin / ".claude-plugin" / "plugin.json").read_text())["name"]
    return [f"Skill({name}:{d.name})" for d in sorted((plugin / "skills").iterdir()) if (d / "SKILL.md").is_file()]


def permits(rules: list[str], tool: str) -> bool:
    """Whether an allow rule lets `tool` run without a permission request, as Claude Code matches one: the tool's own
    name, or its MCP server's whole rule (`mcp__<server>`, or `mcp__<server>__*`)."""
    server = tool.rsplit("__", 1)[0] if tool.startswith("mcp__") else None
    return any(r == tool or (server is not None and r in (server, server + "__*")) for r in rules)


def allowed(argv: list[str]) -> list[str]:
    return argv[argv.index("--allowedTools") + 1:argv.index("--disallowedTools")]  # every session has both


def own_tools(argv: list[str], plugin: Path) -> list[str]:
    """The thimble tools a session has: its agent names no tools, so every tool of the plugin copy it loads that its
    --disallowedTools leave, which name them as that copy does."""
    agent = next(iter(json.loads(argv[argv.index("--agents") + 1]).values()))
    assert "tools" not in agent, "the agent inherits every tool of the session"
    i, denied = argv.index("--disallowedTools") + 1, set()
    while i < len(argv) and not argv[i].startswith("--"):
        denied.add(argv[i])
        i += 1
    names = set(model_names(plugin).values())
    assert {t for t in denied if t.startswith("mcp__")} <= names, "the tools taken away are the plugin copy's"
    return sorted(names - denied)


def assert_own_tools_ask_nothing(argv: list[str], plugin: Path) -> None:
    """Every thimble tool the session has, and every skill of the plugin, is allowed."""
    rules = allowed(argv)
    own = own_tools(argv, plugin)
    assert own, "the session keeps thimble tools of its own"
    assert [t for t in own if not permits(rules, t)] == [], "no thimble tool of the session asks"
    assert [s for s in skill_names(plugin) if s not in rules] == [], "no skill of the plugin asks"


async def test_a_writer_calls_its_thimble_tools_without_a_permission_request(install, fake):
    res = await tools.call(CORPUS, "start_writing", {"doc": "report", "request": "Count the runs."})
    assert not res.is_error, res.text
    await _done("writer:report")
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--plugin-dir") + 1] == str(install.session)
    assert_own_tools_ask_nothing(argv, install.session)
    assert {"mcp__plugin_thimble_thimble__write_document", "mcp__plugin_thimble_thimble__add_card"} <= \
        set(own_tools(argv, install.session)), "a writer's calls ask nothing"


def _assert_works_in_its_own_folder(fake: Path, work: Path) -> None:
    """The session's process runs in `work` with the corpus folder added and denied to every file tool, and its edits in
    `work` and its Bash in the sandbox, off the network, ask nothing (agent_session, the fence)."""
    corpus = config.corpus_dir(CORPUS)
    argv = json.loads((fake / "argv.json").read_text())
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert json.loads((fake / "env.json").read_text())["cwd"] == str(work)
    assert argv[argv.index("--add-dir") + 1] == str(corpus)
    assert settings["permissions"]["deny"] == [f"Edit(/{corpus}/**)"]
    assert settings["permissions"]["allow"] == [f"Edit(/{work}/**)"]
    assert settings["sandbox"]["autoAllowBashIfSandboxed"] and settings["sandbox"]["network"] == {"deniedDomains": ["*"]}
    assert [h["matcher"] for h in settings["hooks"]["PreToolUse"]] == ["Bash"], "the sandbox hook allows sandboxed Bash"


async def test_a_writer_and_a_critique_have_bash_and_the_file_tools_so_they_work_in_a_folder_of_their_own(fake, monkeypatch):
    from app import critique_session, write_session

    monkeypatch.setenv("THIMBLE_SANDBOX", "1")
    res = await tools.call(CORPUS, "start_writing", {"doc": "report"})
    assert not res.is_error, res.text
    await _done("writer:report")
    _assert_works_in_its_own_folder(fake, write_session.work_dir(CORPUS, "report"))
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE)["id"]
    agent_session._runs[(CORPUS, KEY)] = agent_session.Run(CORPUS, KEY, chat, "5f0c2a6e-1b7d-4c1e-9a52-6f3d8e2b7c10",
                                                           Path("/corpus"), orientation.ROLE)
    res = await tools.call(CORPUS, "critique", {"context": "Twelve runs."}, session=KEY)
    assert not res.is_error, res.text
    work = config.workspace_dir(CORPUS) / critique_session.DIGEST_DIR / chat / critique_session.WORK_DIR
    _assert_works_in_its_own_folder(fake, work)


async def test_the_writer_of_the_orientations_report_pass_carries_the_orientation(install, fake):
    """A writer that answers the orientation's report pass (orientation.request_report marks the pending write) names
    the orientation's chat and run on its meta, which the browser reads to show it on the orientation's card; a writer
    the analyst asked for names none."""
    from app import report_types

    report_types.write_requested(CORPUS, {"doc": "report"}, {"id": "ev1"})
    report_types.write_for_orientation(CORPUS, "report", "orient1", 2)
    res = await tools.call(CORPUS, "start_writing", {"doc": "report"})
    assert not res.is_error, res.text
    await _done("writer:report")
    writers = [m for m in agents.list_chats(CORPUS) if m.get("role") == "writer"]
    assert [(m.get("orient"), m.get("orient_run")) for m in writers] == [("orient1", 2)]
    res = await tools.call(CORPUS, "start_writing", {"doc": "report", "request": "Shorter."})
    assert not res.is_error, res.text
    await _done("writer:report")
    later = [m for m in agents.list_chats(CORPUS) if m.get("role") == "writer" and m["id"] != writers[0]["id"]]
    assert len(later) == 1 and "orient" in later[0] and later[0]["orient"] is None
    assert report_types._writer_chat(SimpleNamespace(c=CORPUS, session=None)) is None, "main's saves name no writer"


async def test_the_orientation_calls_every_thimble_tool_it_has_without_a_permission_request(install, fake):
    """The orientation's agent names no tools, so it has every tool of the plugin's server that its --disallowedTools
    leave it; each of those is allowed, and a denied one stays denied, since a deny wins over an allow."""
    _listen()
    res = await tools.call(CORPUS, "start_orientation", {"brief": "the runs", "generate_report": False})
    assert not res.is_error, res.text
    await _done()
    argv = json.loads((fake / "argv.json").read_text())
    assert argv[argv.index("--plugin-dir") + 1] == str(install.session)
    rules = argv[argv.index("--allowedTools") + 1:argv.index("--disallowedTools")]
    denied = set(argv[argv.index("--disallowedTools") + 1:])
    names = model_names(install.session)
    kept = [n for n in names.values() if n not in denied]
    assert names["add_card"] in kept and names["start_writing"] in denied
    assert [t for t in kept if not permits(rules, t)] == [], "no thimble tool it has asks"
    assert [s for s in skill_names(install.session) if s not in rules] == [], "no skill of the plugin asks"


def test_main_calls_every_thimble_tool_without_a_permission_request(install):
    """Main's launcher passes the second line of `thimble launch-args` as --allowedTools (plugin/bin/thimble), for the
    plugin copy main runs from."""
    rules = cli.launch_args(config.corpus_dir(CORPUS)).split("\n", 2)[1].split(",")
    assert [t for t in model_names(install.main).values() if not permits(rules, t)] == []
    assert [s for s in skill_names(install.main) if s not in rules] == []
