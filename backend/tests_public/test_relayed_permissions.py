"""Permission prompts the PermissionRequest hook tells the server of (events.py, session.py): thimble makes no allow
decision (0.9.0, S11), so the hook gets `behavior: null` at once and Claude Code asks in the terminal; the prompt shows
on main's card without buttons while main's own turn is over, and stays until its call's result shows in the agent's
transcript (answered in the terminal) or the agent stops, whatever main's turn does meanwhile. The words Claude Code's
own dialog uses for its "don't ask again" are still computed (permission_updates), for the card's text. Every
transcript, Claude Code's session record and its managed settings are written by the test."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app import agent_session, agents, cc_plugin, config, events, permission_updates, session

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-0000000000aa"
PID = 4242


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


def _held() -> list[str]:
    return [p["id"] for p in (agents.meta_or_none(CORPUS, agents.MAIN_ID) or {}).get("permissions") or []]


class Req:
    """The hook's request, whose client stays connected, for calling the route function directly."""

    async def is_disconnected(self) -> bool:
        return False


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
