"""Permission prompts the PermissionRequest hook relays for main's background subagents (events.py, session.py): each
asks while main's own turn is over, and stays on the card until the analyst answers it here, its call's result shows
in the agent's transcript (answered in the terminal), or the agent stops, whatever main's turn does meanwhile. The
card's "Always allow" offers exactly the permission_suggestions Claude Code gave, each kept where Claude Code gave it,
and nothing without them or under the managed tier's allowManagedPermissionRulesOnly. Every transcript, Claude Code's
session record and its managed settings are written by the test."""
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


# what Claude Code 2.1.300 suggests for a call of one of thimble's tools and for a Bash command (its dialog's "Yes, and
# don't ask again for ... in <folder>"), and for an edit outside the folder ("allow all edits during this session")
ADD_CARD = [{"type": "addRules", "rules": [{"toolName": "mcp__plugin_thimble_thimble__add_card"}], "behavior": "allow",
             "destination": "localSettings"}]
WC = [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "wc -l *"}], "behavior": "allow",
       "destination": "localSettings"}]
OUTSIDE = [{"type": "addDirectories", "directories": ["/data/notes"], "destination": "session"},
           {"type": "setMode", "mode": "acceptEdits", "destination": "session"}]
CARD_INPUT = {"question": "How many files are there?", "code": "len(files)"}


def _main_attached() -> None:
    assert session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), None) is not None


def _entry(request_id: str) -> dict:
    return next(p for p in (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []
                if p["id"] == request_id)


async def _ask(suggestions, tool_name: str = "mcp__plugin_thimble_thimble__add_card", tool_input=None,
               agent_id: str | None = None) -> tuple[asyncio.Future, dict]:
    """The hook relays one of main's prompts with Claude Code's suggestions; returns its call and its card entry."""
    before = set(_held())
    call = asyncio.ensure_future(events.hook_permission_route(Req(), events.HookPermission(
        cwd=str(config.corpus_dir(CORPUS)), session=SID, tool_name=tool_name,
        tool_input=CARD_INPUT if tool_input is None else tool_input, agent_id=agent_id, suggestions=suggestions)))
    for _ in range(200):
        await asyncio.sleep(0.01)
        if set(_held()) - before:
            break
    [request_id] = set(_held()) - before
    return call, _entry(request_id)


def _answers() -> dict[str, str]:
    log = [json.loads(ln) for ln in (config.workspace_dir(CORPUS) / agents.PERMISSIONS_LOG).read_text().splitlines()]
    return {r["id"]: r["answer"] for r in log if r["event"] == "answered"}


def test_main_s_offer_is_claude_code_s_suggestions_with_each_destination_and_only_what_allows():
    for given in (ADD_CARD, WC, OUTSIDE, WC + OUTSIDE):
        assert permission_updates.main_offer(given) == given, "exactly as Claude Code gave them"
    left_out = [
        {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "deny", "destination": "localSettings"},
        {"type": "removeRules", "rules": [{"toolName": "Bash"}], "behavior": "deny", "destination": "localSettings"},
        {"type": "setMode", "mode": "bypassPermissions", "destination": "session"},
        {"type": "addRules", "rules": [{"toolName": "Read"}], "behavior": "allow", "destination": "elsewhere"},
        {"type": "addDirectories", "directories": ["/data/x"]},
    ]
    assert permission_updates.main_offer(left_out + WC) == WC
    assert permission_updates.main_offer(None) == permission_updates.main_offer("x") == []
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
    for its "Yes": the button short, the tooltip whole and with where Claude Code keeps the update."""
    words = permission_updates.main_words
    saved = "Claude Code saves this in this folder's local settings (.claude/settings.local.json)."
    # "Yes, and don't ask again for plugin:thimble:thimble — Add Card commands in <folder>"
    assert words(ADD_CARD, "/w/corpus") == {
        "always_label": "Allow, and don't ask again for plugin:thimble:thimble \u2014 Add Card commands",
        "always_tip": ("Allow, and don't ask again for plugin:thimble:thimble \u2014 Add Card commands in /w/corpus. "
                       f"{saved}")}
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
        "always_label": "Allow, and don't ask again for demo \u2014 List Open Items commands",
        "always_tip": ("Allow, and don't ask again for demo \u2014 List Open Items commands. Claude Code saves this in "
                       "your user settings, for any project.")}
    assert permission_updates.tool_words("Bash") == "Bash"


async def test_always_allow_on_main_s_card_answers_with_exactly_what_the_card_named(monkeypatch):
    _main_attached()
    monkeypatch.setattr(hook_auth, "analyst", lambda request: True)
    call, entry = await _ask(ADD_CARD)
    assert entry["always"] == "mcp__plugin_thimble_thimble__add_card"
    assert entry["always_label"] == "Allow, and don't ask again for plugin:thimble:thimble \u2014 Add Card commands"
    assert entry["always_tip"] == ("Allow, and don't ask again for plugin:thimble:thimble \u2014 Add Card commands in "
                                   f"{config.corpus_dir(CORPUS)}. Claude Code saves this in this folder's local "
                                   "settings (.claude/settings.local.json).")
    assert events._offers == {entry["id"]: ADD_CARD}, "the suggestions are stored with the request"
    await events.permission_route(CORPUS, events.PermissionAnswer(id=entry["id"], allow=True, always=True), Browser())
    got = await asyncio.wait_for(call, 5)
    assert got == {"id": entry["id"], "behavior": "allow", "updatedPermissions": ADD_CARD}
    assert events._offers == {} and _held() == []
    assert _answers()[entry["id"]] == "allow, don't ask again: mcp__plugin_thimble_thimble__add_card"

    # Allow alone, or Deny, adds nothing
    for allow in (True, False):
        call, entry = await _ask(WC, "Bash", {"command": "wc -l agents.jsonl"})
        assert entry["always"] == "Bash(wc -l *)"
        await events.permission_route(CORPUS, events.PermissionAnswer(id=entry["id"], allow=allow, always=not allow),
                                      Browser())
        assert await asyncio.wait_for(call, 5) == {"id": entry["id"], "behavior": "allow" if allow else "deny"}
        assert _answers()[entry["id"]] == ("allow" if allow else "deny")
    assert events._offers == {}


@pytest.mark.parametrize("managed", ["remote-settings.json in Claude Code's config dir", "managed-settings.json"])
async def test_no_always_allow_without_suggestions_or_under_the_managed_rules_only_key(managed, tmp_path, monkeypatch):
    _main_attached()
    monkeypatch.setattr(hook_auth, "analyst", lambda request: True)

    async def once(suggestions, *args, **kw) -> dict:
        """The card entry of a prompt the analyst answers with `always`, which then allows it once."""
        call, entry = await _ask(suggestions, *args, **kw)
        await events.permission_route(CORPUS, events.PermissionAnswer(id=entry["id"], allow=True, always=True),
                                      Browser())
        assert await asyncio.wait_for(call, 5) == {"id": entry["id"], "behavior": "allow"}
        return entry

    deny = [{"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "deny", "destination": "localSettings"}]
    for none in (None, [], deny):
        assert "always" not in await once(none)
    # a request the card shows only the start of offers none, as on every card
    assert "always" not in await once(WC, "Bash", {"command": "wc -l " + "x" * events.PERMISSION_INPUT_CHARS})
    # one of thimble's agents asks in the terminal, and its card has no buttons
    monkeypatch.setattr(events, "_thimble_agent", lambda c, agent: agent == "t1")
    call, entry = await _ask(ADD_CARD, agent_id="t1")
    assert entry["terminal"] and "always" not in entry and (await asyncio.wait_for(call, 5))["behavior"] is None
    assert events._offers == {}

    if managed.startswith("remote"):
        tier = tmp_path / "claude-config" / cc_plugin.REMOTE_SETTINGS
    else:
        tier = tmp_path / "managed" / cc_plugin.MANAGED_FILE
    tier.parent.mkdir(parents=True, exist_ok=True)
    tier.write_text(json.dumps({"allowManagedPermissionRulesOnly": True}))
    assert "always" not in await once(ADD_CARD)
    tier.write_text(json.dumps({"allowManagedPermissionRulesOnly": False}))
    call, entry = await _ask(ADD_CARD)
    assert entry["always"] == "mcp__plugin_thimble_thimble__add_card"
    events.clear_permissions(CORPUS)
    assert (await asyncio.wait_for(call, 5))["behavior"] is None and events._offers == {}
