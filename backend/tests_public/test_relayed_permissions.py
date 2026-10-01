"""Permission prompts the channel relays (channel.py, session.py): such a prompt names no agent, and main's background
subagents ask while main's own turn is over. Each stays on the card until the analyst answers it here, its call's result
shows in a transcript (answered in the terminal), or nothing in the session can still be asking, whatever main's turn
does meanwhile. Every transcript and Claude Code's session record are written by the test."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, cc_channel, channel, config, hook_auth, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000aa"
PID = 4242
AGENTS = ("a1", "a2", "a3", "a4")
COMMANDS = {"a1": "wc -l agents.jsonl", "a2": "wc -l villages.jsonl", "a3": "wc -l goals.jsonl",
            "a4": "wc -l villages.jsonl"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    for table in (session._live, session._expected, session._event_threads, session._came_back, session._shim_pids,
                  session._shim_configs, channel._subs, channel._routes, channel._asks, channel._relayed,
                  channel._relayed_answered):
        table.clear()
    agents._busy.clear()
    yield
    for table in (session._live, channel._subs, channel._routes, channel._asks, channel._relayed,
                  channel._relayed_answered):
        table.clear()


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-5", "content": list(blocks)}}


def _use(tool_use_id: str, name: str, tool_input: dict) -> dict:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _result(tool_use_id: str, content: str) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}]}}


def _write(p: Path, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))


def _state(status: str, waiting_for: str | None = None) -> None:
    """Claude Code's own record of the session, as session.session_state reads it."""
    d = Path(str(config.claude_config_dir())) / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{PID}.json").write_text(json.dumps({"pid": PID, "sessionId": SID, "status": status,
                                               **({"waitingFor": waiting_for} if waiting_for else {})}))


def _held() -> list[str]:
    return [p["id"] for p in (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []]


def _preview(command: str) -> str:
    """The input as Claude Code previews it for a channel (`{ "key": value, … }`)."""
    return "{ " + f'"command": {json.dumps(command)}' + " }"


class Browser:
    """A request from the analyst's browser, for calling the answer route directly."""

    cookies: dict = {}
    headers: dict = {}


async def _main_waits_on_four_background_agents(tmp_path: Path) -> tuple[session.Live, dict[str, Path]]:
    """Main starts four background agents and its turn ends; each agent then asks to run a Bash command, and the channel
    relays the four prompts at once."""
    transcript = tmp_path / f"{SID}.jsonl"
    transcript.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(transcript), pid=PID)
    assert lv is not None
    _state("busy")
    session.tail_once(lv)
    _write(transcript, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Count each file."}}])
    _write(transcript, [_assistant(*[_use(f"toolu_{a}", "Agent", {"description": f"Count {a}", "prompt": "Count.",
                                                                  "subagent_type": "general-purpose",
                                                                  "run_in_background": True}) for a in AGENTS])])
    _write(transcript, [_result(f"toolu_{a}", f"Async agent launched successfully.\nagentId: {a}") for a in AGENTS])
    subs = tmp_path / SID / "subagents"
    subs.mkdir(parents=True)
    files = {}
    for a in AGENTS:
        (subs / f"agent-{a}.meta.json").write_text(json.dumps({"toolUseId": f"toolu_{a}", "description": f"Count {a}",
                                                                "agentType": "general-purpose"}))
        files[a] = subs / f"agent-{a}.jsonl"
        _write(files[a], [{"type": "user", "message": {"role": "user", "content": "Count."}},
                          _assistant(_use(f"bash_{a}", "Bash", {"command": COMMANDS[a]}))])
    session.tail_once(lv)
    for a in AGENTS:
        await channel.permission_request_route(channel.PermissionRequest(
            cwd=str(config.corpus_dir(CORPUS)), session=SID, request_id=f"r{a}", tool_name="Bash",
            description="Run shell command", input_preview=_preview(COMMANDS[a])))
    _write(transcript, [_assistant({"type": "text", "text": "Four agents are counting."}),
                        {"type": "system", "subtype": "turn_duration"}])
    return lv, files


async def test_four_relayed_requests_stay_while_main_idles_on_its_background_agents(tmp_path, monkeypatch):
    lv, files = await _main_waits_on_four_background_agents(tmp_path)
    monkeypatch.setattr(session, "RELAYED_IDLE_S", 0.0)
    asked = [f"r{a}" for a in AGENTS]
    assert _held() == asked
    # main's turn ends, and Claude Code's record goes from the prompt to idle and back, as it did when they vanished
    for status, waiting in [("waiting", session.PERMISSION_WAIT), ("idle", None), ("waiting", session.PERMISSION_WAIT),
                            ("busy", None), ("idle", None)]:
        _state(status, waiting)
        session.tail_once(lv)
        if status == "waiting":
            lv.wait = (session.PERMISSION_WAIT, 0.0, False)  # held long enough to be noted
        assert not lv.turn_open and lv.busy, "main's turn is over while its agents run"
        assert _held() == asked, f"with Claude Code {status}"

    # answered in the terminal: a1's call gets its result, and only its request leaves the card
    _write(files["a1"], [_result("bash_a1", "12 agents.jsonl")])
    session.tail_once(lv)
    assert _held() == ["ra2", "ra3", "ra4"]

    # answered here: the answer goes to Claude Code on the channel, and a2's result then answers no other request,
    # though a4 asks to run the same command
    q = channel._subs.setdefault(CORPUS, set())
    stream: list = []
    sub = type("Q", (), {"put_nowait": lambda self, item: stream.append(item)})()
    q.add(sub)
    channel._routes[sub] = (SID, cc_channel.CHANNEL)
    monkeypatch.setattr(hook_auth, "analyst", lambda request: True)
    await channel.permission_route(CORPUS, channel.PermissionAnswer(id="ra2", allow=True), Browser())
    assert stream == [{channel.PERMISSION_EVENT: {"request_id": "ra2", "behavior": "allow"}}]
    _write(files["a2"], [_result("bash_a2", "3 villages.jsonl")])
    session.tail_once(lv)
    assert _held() == ["ra3", "ra4"]

    # a call nobody asked about (allowed without a prompt) answers nothing
    _write(files["a3"], [_assistant(_use("bash_a3_ls", "Bash", {"command": "ls"})), _result("bash_a3_ls", "x")])
    session.tail_once(lv)
    assert _held() == ["ra3", "ra4"]

    # every agent stops and main is idle: nothing in the session can still ask, so the rest leave the card
    for s in lv.subs:
        s.done = True
    _state("idle")
    session.tail_once(lv)
    assert _held() == []
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    answers = {r["id"]: r["answer"] for r in log if r["event"] == "answered"}
    assert answers == {"ra1": channel.GONE_ANSWER, "ra2": "allow", "ra3": channel.GONE_ANSWER,
                       "ra4": channel.GONE_ANSWER}


async def test_a_relayed_request_stays_while_claude_code_shows_a_prompt_and_ends_with_its_session(tmp_path,
                                                                                                  monkeypatch):
    lv, _ = await _main_waits_on_four_background_agents(tmp_path)
    monkeypatch.setattr(session, "RELAYED_IDLE_S", 0.0)
    for s in lv.subs:
        s.done = True
    _state("waiting", session.PERMISSION_WAIT)
    session.tail_once(lv)
    assert len(_held()) == 4, "Claude Code still shows a prompt"
    assert session.detach(CORPUS, SID)
    assert _held() == []


def test_a_relayed_request_is_matched_to_its_call_by_the_field_that_names_it_when_the_preview_is_cut():
    preview = '{ "file_path": "/tmp/out \\"1\\".txt" }\n⋯ 1 field elided: "content" ⋯\n'
    key = channel._entry_key({"tool": "Write", "input": preview})
    assert key == channel.call_key("Write", {"file_path": '/tmp/out "1".txt', "content": "x" * 20_000})
    assert channel._entry_key({"tool": "Bash", "input": _preview("ls  -la")}) == channel.call_key("Bash",
                                                                                                  {"command": "ls -la"})
    assert channel._entry_key({"tool": "Task", "input": "{ cut"}) is None
