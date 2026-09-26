"""terminal_tools.py and what uses it: which calls end main's turn without closing words. The launcher exports the tool
list only for a `claude` that reads it, main's prompt keeps the one ending that applies, the mirror refutes the list when
Claude Code still asks for a reply, the quiet events ride along with the next event under `meanwhile:`, and no chat
shows a line that opens with the terminal-only mark."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app import agents, channel, cli, config, session, terminal_tools

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-00000000c0de"
ADD_CARD = terminal_tools.tool_name("add_card")


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch, workspaces_tmp):
    monkeypatch.setenv("THIMBLE_HOME", str(tmp_path / "home"))
    monkeypatch.delenv(terminal_tools.ENV, raising=False)
    channel._subs.clear()
    channel._held.clear()
    session._live.clear()
    session._expected.clear()
    agents._busy.clear()
    yield
    channel._subs.clear()
    channel._held.clear()
    session._live.clear()


def _claude(tmp_path: Path, reads: bool) -> Path:
    """A stand-in `claude` executable, with or without the variable's name in it."""
    exe = tmp_path / ("claude-reads" if reads else "claude-old")
    exe.write_bytes(b"\x7fELF...." + (terminal_tools.ENV.encode() if reads else b"OTHER_VARIABLE") + b"....")
    exe.chmod(0o755)
    return exe


def test_an_executable_reads_the_variable_when_its_name_is_in_it_and_the_answer_is_kept(tmp_path, monkeypatch):
    new, old = _claude(tmp_path, True), _claude(tmp_path, False)
    assert terminal_tools.supported(new) and not terminal_tools.supported(old) and not terminal_tools.supported(None)
    cache = json.loads((tmp_path / "home" / terminal_tools.CACHE).read_text())
    assert sorted(v["reads"] for v in cache.values()) == [False, True]
    monkeypatch.setattr(terminal_tools, "_reads", lambda p: pytest.fail("the kept answer is used"))
    assert terminal_tools.supported(new)


def test_the_tool_list_is_agent_sendmessage_and_the_thimble_tools_whose_result_the_browser_shows():
    names = terminal_tools.names()
    assert names[:2] == ["Agent", "SendMessage"] and ADD_CARD in names
    assert terminal_tools.tool_name("reply_in_thread") in names and terminal_tools.tool_name("start_orientation") in names
    for read in terminal_tools.READS:
        assert terminal_tools.tool_name(read) not in names, "a turn that ends on a read still needs words"
    own = terminal_tools.value({terminal_tools.ENV: "mcp__other__tool, Agent"})
    assert own.split(",")[:2] == ["mcp__other__tool", "Agent"] and own.count("Agent") == 1, "the analyst's entries stay"


def test_the_launcher_exports_the_list_only_for_a_claude_that_reads_it_and_main_s_prompt_follows(home, data, monkeypatch,
                                                                                                tmp_path):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(tmp_path / "ws"))
    monkeypatch.setenv(terminal_tools.BIN_ENV, str(_claude(tmp_path, True)))
    _channel, _tools, _effort, turn_tools, prompt = cli.launch_args(data / "mini").split("\n", 4)
    assert turn_tools == terminal_tools.value() and ADD_CARD in turn_tools.split(",")
    assert "needs no closing words" in prompt and "`↳`" in prompt
    assert "end it with `(shown in the dashboard)`" not in prompt
    monkeypatch.setenv(terminal_tools.BIN_ENV, str(_claude(tmp_path, False)))
    _channel, _tools, _effort, turn_tools, prompt = cli.launch_args(data / "mini").split("\n", 4)
    assert turn_tools == "" and "end it with `(shown in the dashboard)`" in prompt and "needs no closing words" not in prompt
    script = (config.REPO_ROOT / "plugin" / "bin" / "thimble").read_text()
    assert '[ -z "$turn_tools" ] || export CLAUDE_CODE_TERMINAL_MCP_TOOLS="$turn_tools"' in script
    assert script.index('turn_tools="${rest%%') < script.index('if [ "$cont" = 1 ]; then last=')


def test_a_session_started_some_other_way_gets_the_ending_its_environment_supports(tmp_path, monkeypatch):
    """`thimble prompt main` runs under the session's own `claude`, so its environment says which ending applies."""
    cwd = str(config.corpus_dir(CORPUS))
    assert "end it with `(shown in the dashboard)`" in channel.session_prompt(cwd), "no list: the end token"
    monkeypatch.setenv(terminal_tools.BIN_ENV, str(_claude(tmp_path, True)))
    monkeypatch.setenv(terminal_tools.ENV, terminal_tools.value())
    assert terminal_tools.on() and "needs no closing words" in channel.session_prompt(cwd)
    monkeypatch.setenv(terminal_tools.BIN_ENV, str(_claude(tmp_path, False)))
    assert not terminal_tools.on() and "needs no closing words" not in channel.session_prompt(cwd)


def test_claude_code_asking_for_a_reply_after_a_listed_tool_refutes_the_list_for_its_executable(tmp_path, monkeypatch):
    exe = _claude(tmp_path, True)
    env = {terminal_tools.BIN_ENV: str(exe), terminal_tools.ENV: terminal_tools.value()}
    assert terminal_tools.supported(exe)
    assert not terminal_tools.nudged(env, "Bash"), "Bash is not listed: Claude Code asks for a reply after it anyway"
    assert terminal_tools.supported(exe)
    assert terminal_tools.nudged(env, ADD_CARD)
    assert not terminal_tools.supported(exe) and "does not act on it" in terminal_tools.line(env)
    assert terminal_tools.launch_value(env) == "", "the next launch uses the end token"


def test_the_mirror_refutes_the_list_when_the_nudge_follows_a_listed_call(tmp_path, monkeypatch):
    exe = _claude(tmp_path, True)
    env = {terminal_tools.BIN_ENV: str(exe), terminal_tools.ENV: terminal_tools.value()}
    from app import procs

    monkeypatch.setattr(procs, "environ", lambda pid: env)
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p), pid=4242)
    assert lv is not None
    session.tail_once(lv)
    records = [
        {"type": "user", "origin": {"kind": "human"}, "message": {"content": "Add a card."}},
        {"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": ADD_CARD, "input": {"question": "q"}}]}},
        {"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "card:1a2b3c4d"}]}},
        {"type": "user", "isMeta": True, "message": {"content": terminal_tools.NUDGE + ". Please continue.]"}},
    ]
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in records))
    session.tail_once(lv)
    assert not terminal_tools.supported(exe)


def test_the_terminal_only_lines_and_the_end_token_never_reach_a_chat():
    assert session.visible("↳ thread 1a2b: answered what each field means") == ""
    assert session.visible("The card is on the canvas.\n↳ thread 1a2b: added a card") == "The card is on the canvas."
    assert session.visible("(shown in the dashboard)") == ""
    assert session.visible("An arrow → stays.") == "An arrow → stays."


def _listen() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    channel._subs.setdefault(CORPUS, set()).add(q)
    return q


def test_a_quiet_event_wakes_no_turn_and_rides_along_with_the_next_one():
    q = _listen()
    out = channel.post(CORPUS, "labeled", {"text": "label `asks` over pages.jsonl: 12 of 40"})
    assert out["held"] and out["delivered"] == 0 and q.empty()
    assert not agents.running(CORPUS, agents.MAIN_ID), "main is not woken"
    session.push_event(CORPUS, "view", "view `board` opens posts.jsonl", view="board")
    assert q.empty() and [h["meta"]["kind"] for h in channel.held(CORPUS)] == ["labeled", "view"]
    channel.post(CORPUS, "main", {"text": "What changed?"})
    note = q.get_nowait()
    text, meanwhile = note["content"].split("\n\nmeanwhile:\n")
    assert text == "What changed?" and note["meta"]["kind"] == "main"
    assert meanwhile.splitlines() == ['[kind="labeled"] label `asks` over pages.jsonl: 12 of 40',
                                      '[kind="view" view="board"] view `board` opens posts.jsonl']
    assert channel.held(CORPUS) == [] and q.empty()
    channel.post(CORPUS, "main", {"text": "And now?"})
    assert "meanwhile" not in q.get_nowait()["content"]
