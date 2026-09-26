"""Readable names in the terminal: a thread's event names the fork by the thread's title as a slug, unique in the
workspace, and main forks with `thread:<that name>` as the description, which Claude Code shows in its agent tray. The
mirror joins such a fork to its thread as it joins one described `thread:<id>`, and reply_in_thread, /thimble:ask and the
export take the name too. The orientation's plugin agent is `thimble:orient`."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import agents, channel, config, orientation, session, threads, tools

CORPUS = "mini"
SID = "e7b0a1f2-0000-4000-8000-00000000f0a1"
END = {"type": "system", "subtype": "turn_duration"}
PLUGIN_AGENT = config.REPO_ROOT / "plugin" / "agents" / "orient-subagent.md"


@pytest.fixture(autouse=True)
def _fresh(workspaces_tmp, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    session._live.clear()
    session._expected.clear()
    session._event_threads.clear()
    channel._subs.clear()
    agents._busy.clear()
    yield
    session._live.clear()
    channel._subs.clear()


def _thread(tid: str, title: str) -> dict:
    meta = agents._defaults({"id": tid, "kind": agents.KIND_THREAD, "role": "thread", "title": title, "created_at": "t",
                             "parent": agents.MAIN_ID, "anchor": "card:0a1b2c3d"})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, tid)[1].touch()
    return meta


def test_a_fork_name_is_the_title_as_a_slug_and_unique_in_the_workspace():
    first = _thread("0f0f0001", "Orchard trees 812")
    second = _thread("0f0f0002", "orchard, trees: 812!")
    assert threads.fork_name(CORPUS, first) == "orchard-trees-812"
    assert threads.fork_name(CORPUS, second) == "orchard-trees-812-2", "the second thread with that slug gets a number"
    assert threads.fork_name(CORPUS, agents.read_meta(CORPUS, "0f0f0001")) == "orchard-trees-812", "a name is stable"
    assert threads.by_fork_name(CORPUS, "orchard-trees-812-2") == "0f0f0002"
    assert threads.slug("") == threads.FORK_NAME_FALLBACK
    assert len(threads.slug("word " * 40)) <= threads.FORK_NAME_CHARS


def test_the_thread_event_carries_the_fork_name(monkeypatch):
    _thread("0f0f0003", "Which orchard peaked")
    monkeypatch.setattr(threads, "content", lambda c, meta: "")
    body, fields, tid = threads.build(CORPUS, "0f0f0003", ["Why?"])
    assert fields["thread"] == "0f0f0003" and fields["name"] == "which-orchard-peaked"
    assert 'name="which-orchard-peaked"' in channel.render(channel.notification("thread", "e1", body, fields))


def _assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def _append(p: Path, lv: session.Live, recs: list[dict]) -> None:
    with p.open("a") as f:
        f.write("".join(json.dumps(r) + "\n" for r in recs))
    session.tail_once(lv)


def test_the_mirror_joins_a_fork_described_by_its_name_to_the_thread(tmp_path):
    meta = _thread("0f0f0004", "Hill orchard picks")
    name = threads.fork_name(CORPUS, meta)
    agent, use = "a00000000000000f4", "toolu_named"
    sub = tmp_path / SID / "subagents" / f"agent-{agent}.jsonl"
    sub.parent.mkdir(parents=True, exist_ok=True)
    sub.with_name(f"agent-{agent}.meta.json").write_text(json.dumps(
        {"agentType": "fork", "isFork": True, "description": f"thread:{name}", "toolUseId": use}))
    sub.write_text(json.dumps({"type": "user", "isSidechain": True, "message": {"content": f"thread:{name}"}}) + "\n")
    p = tmp_path / f"{SID}.jsonl"
    p.write_text("")
    lv = session.attach(CORPUS, SID, str(config.corpus_dir(CORPUS)), str(p))
    assert lv is not None
    session.tail_once(lv)
    _append(p, lv, [{"type": "user", "origin": {"kind": "human"}, "message": {"content": "Look."}},
                    _assistant({"type": "tool_use", "id": use, "name": "Agent",
                                "input": {"subagent_type": "fork", "description": f"thread:{name}", "prompt": f"thread:{name}"}}),
                    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": use, "content": [
                        {"type": "text", "text": f"Async agent launched successfully.\nagentId: {agent} (internal ID)"}]}]}},
                    END])
    fork = agents.read_meta(CORPUS, "0f0f0004").get("fork") or {}
    assert fork.get("agent_id") == agent and fork.get("tool_use_id") == use
    assert not [m for m in agents.list_chats(CORPUS) if m.get("role") == "subagent"], "no agent chat of its own"


async def test_reply_in_thread_and_ask_take_the_fork_name():
    meta = _thread("0f0f0005", "River orchard")
    name = threads.fork_name(CORPUS, meta)
    res = await threads.tool_reply_in_thread(tools.Ctx(CORPUS, tools.ANALYST), {"thread": name, "text": "Three picks."})
    assert not res.is_error, res.text
    assert [e["delta"] for e in agents.read_events(agents.paths(CORPUS, "0f0f0005")[1]) if e["type"] == "text"] == ["Three picks."]
    assert [m["id"] for m in threads.find_threads(CORPUS, f"main/{name}")] == ["0f0f0005"]


def test_the_orientation_s_plugin_agent_shows_as_thimble_orient():
    head = PLUGIN_AGENT.read_text("utf-8").split("\n---\n", 1)[0]
    assert "\nname: orient\n" in head + "\n"
    assert orientation.SUBAGENT == "orient" and orientation.is_orient("thimble:orient")
    assert not orientation.is_orient("thimble:writer")
