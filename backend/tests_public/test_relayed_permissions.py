"""Permission prompts the PermissionRequest hook relays for main's background subagents (events.py, session.py): each
asks while main's own turn is over, and stays on the card until the analyst answers it here, its call's result shows
in the agent's transcript (answered in the terminal), or the agent stops, whatever main's turn does meanwhile. Every
transcript and Claude Code's session record are written by the test."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, config, events, hook_auth, session

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
                  session._shim_configs, events._subs, events._asks, events._answered):
        table.clear()
    agents._busy.clear()
    yield
    for table in (session._live, events._subs, events._asks, events._answered):
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


class Req:
    """The hook's request, whose client stays connected, for calling the route function directly."""

    async def is_disconnected(self) -> bool:
        return False


class Browser:
    """A request from the analyst's browser, for calling the answer route directly."""

    cookies: dict = {}
    headers: dict = {}


async def _main_waits_on_four_background_agents(tmp_path: Path):
    """Main starts four background agents and its turn ends; each agent then asks to run a Bash command, and the hook
    relays the four prompts at once. Returns main's Live, the agents' transcripts and, by agent, the hook's call and the
    request id it put on the card."""
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
    calls, ids = {}, {}
    for a in AGENTS:
        before = set(_held())
        calls[a] = asyncio.ensure_future(events.hook_permission_route(Req(), events.HookPermission(
            cwd=str(config.corpus_dir(CORPUS)), session=SID, tool_name="Bash", tool_input={"command": COMMANDS[a]},
            agent_id=a)))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if len(_held()) > len(before):
                break
        [ids[a]] = set(_held()) - before
    _write(transcript, [_assistant({"type": "text", "text": "Four agents are counting."}),
                        {"type": "system", "subtype": "turn_duration"}])
    return lv, files, calls, ids


async def test_four_relayed_requests_stay_while_main_idles_on_its_background_agents(tmp_path, monkeypatch):
    lv, files, calls, ids = await _main_waits_on_four_background_agents(tmp_path)
    asked = [ids[a] for a in AGENTS]
    assert _held() == asked
    # main's turn ends, and Claude Code's record goes from the prompt to idle and back
    for status, waiting in [("waiting", session.PERMISSION_WAIT), ("idle", None), ("waiting", session.PERMISSION_WAIT),
                            ("busy", None), ("idle", None)]:
        _state(status, waiting)
        session.tail_once(lv)
        if status == "waiting":
            lv.wait = (session.PERMISSION_WAIT, 0.0, False)  # held long enough to be noted
        assert not lv.turn_open and lv.busy, "main's turn is over while its agents run"
        assert _held() == asked, f"with Claude Code {status}"
    assert not any(c.done() for c in calls.values())

    # answered in the terminal: a1's call gets its result, and only its request leaves the card
    _write(files["a1"], [_result("bash_a1", "12 agents.jsonl")])
    session.tail_once(lv)
    assert _held() == [ids["a2"], ids["a3"], ids["a4"]]
    assert (await asyncio.wait_for(calls["a1"], 5))["behavior"] is None

    # answered here: the answer goes to a2's hook, and a2's result then answers no other request, though a4 asks to run
    # the same command
    monkeypatch.setattr(hook_auth, "analyst", lambda request: True)
    await events.permission_route(CORPUS, events.PermissionAnswer(id=ids["a2"], allow=True), Browser())
    assert (await asyncio.wait_for(calls["a2"], 5))["behavior"] == "allow"
    _write(files["a2"], [_result("bash_a2", "3 villages.jsonl")])
    session.tail_once(lv)
    assert _held() == [ids["a3"], ids["a4"]]

    # a call nobody asked about (allowed without a prompt) answers nothing
    _write(files["a3"], [_assistant(_use("bash_a3_ls", "Bash", {"command": "ls"})), _result("bash_a3_ls", "x")])
    session.tail_once(lv)
    assert _held() == [ids["a3"], ids["a4"]], "an unasked call ended a3's prompt"

    # the two agents stop: nothing can still ask their prompts, so they leave the card and their hooks' waits end
    note = "<task-notification>\n<task-id>{a}</task-id>\n<status>killed</status>\n</task-notification>"
    _write(tmp_path / f"{SID}.jsonl", [{"type": "user", "origin": {"kind": "task-notification"},
                                        "message": {"content": note.format(a=a)}} for a in ("a3", "a4")])
    session.tail_once(lv)
    assert _held() == []
    assert [(await asyncio.wait_for(calls[a], 5))["behavior"] for a in ("a3", "a4")] == [None, None]
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    answers = {r["id"]: r["answer"] for r in log if r["event"] == "answered"}
    assert answers == {ids["a1"]: events.GONE_ANSWER, ids["a2"]: "allow", ids["a3"]: events.GONE_ANSWER,
                       ids["a4"]: events.GONE_ANSWER}
