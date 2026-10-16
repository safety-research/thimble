"""Permission prompts the PermissionRequest hook tells the server of (events.py, session.py): thimble makes no allow
decision (0.9.0, S11), so the hook gets `behavior: null` at once and Claude Code asks in the terminal; the prompt shows
on main's card without buttons while main's own turn is over, and stays until its call's result shows in the agent's
transcript (answered in the terminal) or the agent stops, whatever main's turn does meanwhile. The words Claude Code's
own dialog uses for its "don't ask again" are still computed (permission_updates), for the card's text. Every
transcript, Claude Code's session record and its managed settings are written by the test."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from app import agent_session, agents, cc_plugin, config, events, hook_auth, permission_updates, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000aa"
PID = 4242
AGENTS = ("a1", "a2", "a3", "a4")
COMMANDS = {"a1": "wc -l agents.jsonl", "a2": "wc -l villages.jsonl", "a3": "wc -l goals.jsonl",
            "a4": "wc -l villages.jsonl"}


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setitem(cc_plugin.MANAGED_DIRS, sys.platform, tmp_path / "managed")  # the machine's own is not read
    for table in (session._live, session._expected, session._event_threads, session._came_back, session._shim_pids,
                  session._shim_configs, events._subs, events._asks, events._answered, events._offers,
                  events._terminal):
        table.clear()
    agents._busy.clear()
    yield
    for table in (session._live, events._subs, events._asks, events._answered, events._offers, events._terminal):
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
    for a in AGENTS:  # the hook's note is answered at once, with no decision
        assert calls[a].done() and calls[a].result() == {"id": ids[a], "behavior": None}
    entries = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
    assert all(e.get("terminal") is True and "always" not in e for e in entries), "no buttons on the card"
    # main's turn ends, and Claude Code's record goes from the prompt to idle and back
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
    assert _held() == [ids["a2"], ids["a3"], ids["a4"]]
    # the browser answers nothing: its answer route refuses, and the card stays
    from fastapi import HTTPException

    monkeypatch.setattr(hook_auth, "analyst", lambda request: True)
    with pytest.raises(HTTPException) as refused:
        await events.permission_route(CORPUS, events.PermissionAnswer(id=ids["a2"], allow=True), Browser())
    assert refused.value.status_code == 409 and refused.value.detail == events.ANSWER_IN_TERMINAL
    assert _held() == [ids["a2"], ids["a3"], ids["a4"]]
    _write(files["a2"], [_result("bash_a2", "3 villages.jsonl")])
    session.tail_once(lv)
    assert _held() == [ids["a3"], ids["a4"]]

    # a call nobody asked about (allowed without a prompt) answers nothing
    _write(files["a3"], [_assistant(_use("bash_a3_ls", "Bash", {"command": "ls"})), _result("bash_a3_ls", "x")])
    session.tail_once(lv)
    assert _held() == [ids["a3"], ids["a4"]], "an unasked call ended a3's prompt"

    # the two agents stop: nothing can still ask their prompts, so they leave the card
    note = "<task-notification>\n<task-id>{a}</task-id>\n<status>killed</status>\n</task-notification>"
    _write(tmp_path / f"{SID}.jsonl", [{"type": "user", "origin": {"kind": "task-notification"},
                                        "message": {"content": note.format(a=a)}} for a in ("a3", "a4")])
    session.tail_once(lv)
    assert _held() == []


async def test_main_s_own_prompt_is_answered_at_once_and_its_card_goes_with_its_call_s_result(tmp_path):
    """Main's own prompt too: the hook's note is answered at once with no decision, the card shows it without buttons
    and with no "Always allow", and main's call's result takes it away."""
    transcript = tmp_path / f"{SID}.jsonl"
    transcript.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(transcript), pid=PID)
    assert lv is not None
    session.tail_once(lv)
    _write(transcript, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Count."}},
                        _assistant(_use("toolu_wc", "Bash", {"command": "wc -l a.jsonl"}))])
    session.tail_once(lv)
    got = await events.hook_permission_route(Req(), events.HookPermission(
        cwd=str(config.corpus_dir(CORPUS)), session=SID, tool_name="Bash", tool_input={"command": "wc -l a.jsonl"},
        suggestions=WC))
    assert got["behavior"] is None
    [entry] = (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
    assert entry["id"] == got["id"] and entry["terminal"] is True and "always" not in entry
    _write(transcript, [_result("toolu_wc", "4 a.jsonl")])
    session.tail_once(lv)
    assert _held() == []


# what Claude Code 2.1.300 suggests for a call of one of thimble's tools and for a Bash command (its dialog's "Yes, and
# don't ask again for ... in <folder>"), and for an edit outside the folder ("allow all edits during this session")
ADD_CARD = [{"type": "addRules", "rules": [{"toolName": "mcp__plugin_thimble_thimble__add_card"}], "behavior": "allow",
             "destination": "localSettings"}]
WC = [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "wc -l *"}], "behavior": "allow",
       "destination": "localSettings"}]
OUTSIDE = [{"type": "addDirectories", "directories": ["/data/notes"], "destination": "session"},
           {"type": "setMode", "mode": "acceptEdits", "destination": "session"}]
CARD_INPUT = {"question": "How many files are there?", "code": "len(files)"}


def test_main_s_offer_is_claude_code_s_suggestions_with_each_destination_and_only_what_allows():
    for given in (ADD_CARD, WC, OUTSIDE, WC + OUTSIDE):
        assert permission_updates.main_offer(given, "Write") == given, "exactly as Claude Code gave them"
    left_out = [
        {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "deny", "destination": "localSettings"},
        {"type": "removeRules", "rules": [{"toolName": "Bash"}], "behavior": "deny", "destination": "localSettings"},
        {"type": "setMode", "mode": "bypassPermissions", "destination": "session"},
        {"type": "addRules", "rules": [{"toolName": "Read"}], "behavior": "allow", "destination": "elsewhere"},
        {"type": "addDirectories", "directories": ["/data/x"]},
    ]
    assert permission_updates.main_offer(left_out + WC, "Write") == WC
    assert permission_updates.main_offer(None, "Write") == permission_updates.main_offer("x", "Write") == []
    # the switch to acceptEdits only where Claude Code's own dialog offers it, its file edit dialog: its Bash dialog
    # offers the rules and folders, its dialog for another tool the rules
    for tool in ("Edit", "MultiEdit", "Write", "NotebookEdit"):
        assert permission_updates.main_offer(WC + OUTSIDE, tool) == WC + OUTSIDE, tool
    for tool in ("Bash", "mcp__plugin_thimble_thimble__add_card", "Read"):
        assert permission_updates.main_offer(WC + OUTSIDE, tool) == WC + OUTSIDE[:1], tool
        assert permission_updates.main_offer(OUTSIDE[1:], tool) == [], tool
    # a session thimble started still keeps every update for the session alone
    assert {u["destination"] for u in agent_session.offer(WC + OUTSIDE)} == {"session"}
    saved = "Claude Code saves this in this folder's local settings (.claude/settings.local.json)."
    assert permission_updates.main_words(WC) == {"always_label": "Allow, and don\u2019t ask again for: wc -l *",
                                                 "always_tip": f"Allow, and don\u2019t ask again for: wc -l *. {saved}"}
    # several updates in Claude Code's order (the switch of mode, folders, rules), joined as it joins its rows
    assert permission_updates.main_words(WC + OUTSIDE) == {
        "always_label": ("Allow, and switch to accept edits; always allow access to notes/; don\u2019t ask again for: "
                         "wc -l *"),
        "always_tip": ("Allow, and switch to accept edits (auto-approve file edits and common file commands) for this "
                       "session; always allow access to /data/notes for this session; don\u2019t ask again for: "
                       f"wc -l *. {saved}")}


def test_main_s_card_words_its_offer_as_claude_code_s_own_dialog_does():
    """The rows Claude Code 2.1.300's terminal dialog showed for these permission_suggestions, with the card's "Allow"
    for its "Yes": the button short, the tooltip whole and with where Claude Code keeps the update. The button names an
    MCP tool by its title alone: with the server's name and `commands` it showed only "Allow, and don't ask again for…"
    in the chat's width (live check 7.f). Every row the card words itself has the curly apostrophe of Claude Code's Bash
    rows, which showed beside an MCP tool's straight one on the same card (live check L4); Claude Code's own MCP row
    has a straight one and no colon."""
    words = permission_updates.main_words
    saved = "Claude Code saves this in this folder's local settings (.claude/settings.local.json)."
    # "Yes, and don't ask again for plugin:thimble:thimble — Add Card commands in <folder>"
    assert words(ADD_CARD, "/w/corpus") == {
        "always_label": "Allow, and don\u2019t ask again for Add Card",
        "always_tip": ("Allow, and don\u2019t ask again for plugin:thimble:thimble \u2014 Add Card commands in "
                       f"/w/corpus. {saved}")}
    # "Yes, and don’t ask again for: npm run *"
    npm = [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm run *"}], "behavior": "allow",
            "destination": "localSettings"}]
    assert words(npm, "/w/corpus") == {"always_label": "Allow, and don\u2019t ask again for: npm run *",
                                       "always_tip": f"Allow, and don\u2019t ask again for: npm run *. {saved}"}
    # a Write outside the folder: "Yes, and switch to accept edits (auto-approve file edits and common file commands)
    # for this session; Yes, and always allow access to /data/notes for this session"
    assert words(OUTSIDE[::-1], "/w/corpus") == words(OUTSIDE, "/w/corpus") == {
        "always_label": "Allow, and switch to accept edits; always allow access to notes/",
        "always_tip": ("Allow, and switch to accept edits (auto-approve file edits and common file commands) for this "
                       "session; always allow access to /data/notes for this session")}
    # "Yes, allow reading from /data/notes during this session"
    read = [{"type": "addRules", "rules": [{"toolName": "Read", "ruleContent": "//data/notes/**"}], "behavior": "allow",
             "destination": "session"}]
    assert words(read, "/w/corpus") == {"always_label": "Allow reading from notes/",
                                        "always_tip": "Allow reading from /data/notes during this session"}
    # another server's tool, saved for every folder
    other = [{"type": "addRules", "rules": [{"toolName": "mcp__demo__list_open_items"}], "behavior": "allow",
              "destination": "userSettings"}]
    assert words(other, "/w/corpus") == {
        "always_label": "Allow, and don\u2019t ask again for List Open Items",
        "always_tip": ("Allow, and don\u2019t ask again for demo \u2014 List Open Items commands. Claude Code saves "
                       "this in your user settings, for any project.")}
    assert permission_updates.tool_words("Bash") == "Bash"
    # a tool that is no MCP tool keeps Claude Code's words on the button too
    search = [{"type": "addRules", "rules": [{"toolName": "WebSearch"}], "behavior": "allow", "destination": "session"}]
    assert words(search, "/w/corpus") == {"always_label": "Allow, and don\u2019t ask again for WebSearch commands",
                                          "always_tip": "Allow, and don\u2019t ask again for WebSearch commands for "
                                                        "this session"}
    # a site, and a rule of another tool
    site = [{"type": "addRules", "rules": [{"toolName": "WebFetch", "ruleContent": "domain:example.com"}],
             "behavior": "allow", "destination": "session"}]
    assert words(site, "/w/corpus") == {"always_label": "Allow, and don\u2019t ask again for example.com",
                                        "always_tip": "Allow, and don\u2019t ask again for example.com for this session"}
    skill = [{"type": "addRules", "rules": [{"toolName": "Skill", "ruleContent": "thimble:shared"}], "behavior": "allow",
              "destination": "session"}]
    assert words(skill, "/w/corpus")["always_label"] == "Allow, and don\u2019t ask again for Skill(thimble:shared)"
