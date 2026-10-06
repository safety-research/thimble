"""The writer and the critic as subagents (write_session.py, critique_session.py): Write in the browser starts a writer
through thimble's module with its context in a file its prompt names, two writers of two documents are told apart by
their request ids, and a second writer of one document is refused; the orientation's `critique` writes the digest and
the brief, records a pending critic start that only the orientation's own Agent call can claim, pauses its chat, and
finds its descendants' transcripts by `parentAgentId`. Main's permission requests wait for the analyst as before, while
a request of one of thimble's agents is answered in the terminal at once and its card has no buttons (U6b)."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from app import agents, config, critique_session, events, orientation, report_types, subagents, tools, write_session
from app import subagent_files as sf
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"


@pytest.fixture()
def models(monkeypatch):
    rows = {"orient": {"model": "claude-opus-5-5[1m]", "effort": "max", "fast": False},
            "subagents": {"model": "claude-sonnet-5", "effort": "medium", "fast": False},
            "critic": {"model": "claude-opus-5-5", "effort": "xhigh", "fast": False},
            "writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    monkeypatch.setattr(config, "models_for", lambda c=None: {k: dict(v) for k, v in rows.items()})


async def test_write_starts_the_writer_through_the_module_with_its_context_file(bridge, models, workspaces_tmp):
    ans = await write_session.start(CORPUS, "report", "Shorter, please.", route=subagents.CLICK)
    assert ans.started
    [spawn] = bridge.ops("spawn")
    path = write_session.work_dir(CORPUS, "report") / write_session.CONTEXT_FILE
    assert path.is_file() and "report:report" in path.read_text() and "Shorter, please." in path.read_text()
    assert f"READ {path} FIRST" in spawn["prompt"] and spawn["values"] == {"model": "claude-opus-5-5", "effort": "high"}
    assert spawn["description"] == "writer: report" and spawn["what"] == "report"
    meta = agents.read_meta(CORPUS, subagents.agent(CORPUS, ans.agent_id)["chat"])
    assert meta["role"] == "writer" and meta["doc"] == "report" and meta["title"] == "Write report"
    again = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert again.kind == "hook", "a second writer of the document"


async def test_two_typed_writers_of_two_documents_are_claimed_by_their_request_ids(bridge, models, workspaces_tmp):
    report_types.create_document_type(CORPUS, "casefile", name="Cases", slug="cases")
    got = {}
    for doc in ("report", "cases"):
        res = await tools.call(CORPUS, "start_writing", {"doc": doc, "model": "sonnet"})
        assert not res.is_error, res.text
        got[doc] = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    with subagents.update(CORPUS) as state:
        for i, doc in enumerate(("cases", "report")):
            assert sf.check_call(state, {"tool_name": "Agent", "tool_use_id": f"toolu_{i}", "tool_input": got[doc]}) is None
    reqs = {r["key"]: r for r in subagents.read(CORPUS)["requests"].values()}
    assert reqs["writer:cases"]["claimed_by"] == "toolu_0" and reqs["writer:report"]["claimed_by"] == "toolu_1"
    assert reqs["writer:report"]["values"]["model"] == "claude-sonnet-5"


async def test_a_refused_writer_start_shows_on_its_document(bridge, models, workspaces_tmp, monkeypatch):
    seen: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    bridge.answers.append({"limit": "Claude Code runs at most 20 concurrent subagents"})
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert ans.kind == "limit"
    refused = [r for r in seen if r.get("status") == "refused"]
    assert refused and refused[-1]["slug"] == "report" and refused[-1]["refused"]["kind"] == "limit"
    assert report_types.write_pending(CORPUS, "report") is None


async def test_the_writer_s_end_tells_main_and_lets_go_of_its_work_files(bridge, models, workspaces_tmp, monkeypatch):
    told: list[tuple] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append((kind, payload)))
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Wrote the report.", source="handback")
    assert told == [(write_session.WRITTEN_KIND, {"text": "Wrote the report.", "status": "done", "doc": "report"})]


# --------------------------------------------------------------------------- the critic


async def test_critique_writes_the_brief_and_gives_the_orientation_its_agent_call(bridge, models, workspaces_tmp,
                                                                                monkeypatch):
    from app import orient_session

    async def no_checks(c, chat=None):
        return None

    monkeypatch.setattr(critique_session, "checks_text", no_checks)
    ans = await orient_session.start(CORPUS, "", ["final"], critique=True, route=subagents.CLICK)
    ctx = type("Ctx", (), {"c": CORPUS, "session": "orient", "tool_use_id": "toolu_cq"})()
    res = await critique_session.tool_critique(ctx, {"context": "My account."})
    assert not res.is_error, res.text
    inp = json.loads(res.text.split("AGENT CALL ", 1)[1].splitlines()[0])
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    brief = config.workspace_dir(CORPUS) / "critique" / chat / critique_session.BRIEF_FILE
    assert brief.is_file() and "My account." in brief.read_text()
    assert inp["subagent_type"] == "thimble:critic" and f"READ {brief} FIRST" in inp["prompt"]
    assert agents.read_meta(CORPUS, chat)["paused"] == "critique"
    r = next(r for r in subagents.read(CORPUS)["requests"].values() if r["role"] == "critic")
    assert r["values"] == {"model": "claude-opus-5-5", "effort": "xhigh"} and r["caller_role"] == "orientation"
    assert r["work"] == str(config.workspace_dir(CORPUS) / "critique-work" / chat)
    with subagents.update(CORPUS) as state:
        main_call = {"tool_name": "Agent", "tool_use_id": "toolu_m", "tool_input": inp}
        assert sf.check_call(state, main_call) is not None, "main cannot start the critic"
        assert sf.check_call(state, {**main_call, "agent_id": ans.agent_id}) is None
        entry = sf.register(state, {"agent_id": "crit1", "agent_type": "thimble:critic", "session_id": "s"})
    assert entry["parent"] == ans.agent_id and entry["key"] == "critique:orient"
    meta = subagents.ensure_chat(CORPUS, "crit1")
    assert meta["role"] == agents.STEP_ROLE and meta["parent"] == chat and meta["title"] == "critique"
    subagents.run_ended(CORPUS, "crit1", "done", "The critic's report.", source="handback")
    assert agents.read_meta(CORPUS, chat).get("paused") is None, "the report continues the orientation's run"


async def test_critique_is_the_orientation_s_alone(bridge, models, workspaces_tmp):
    ctx = type("Ctx", (), {"c": CORPUS, "session": None, "tool_use_id": "t"})()
    res = await critique_session.tool_critique(ctx, {})
    assert res.is_error and res.text == tools.hint("critique-not-orientation")


def test_the_digest_of_a_subagent_orientation_holds_its_descendants_found_by_parent_agent_id(workspaces_tmp, tmp_path,
                                                                                            monkeypatch):
    from app import session

    sid = "70e0e27e-eb46-462b-8a9a-57b2e924dca1"
    proj = tmp_path / "projects" / "-corpus"
    folder = proj / sid / "subagents"
    folder.mkdir(parents=True)
    (proj / f"{sid}.jsonl").write_text("")
    monkeypatch.setattr(session, "find_transcript", lambda s, config_dir=None: str(proj / f"{s}.jsonl"))

    def put(agent: str, text: str, **meta) -> None:
        rec = {"type": "assistant", "timestamp": f"2026-10-06T00:0{len(meta)}:00Z",
               "message": {"content": [{"type": "text", "text": text}]}}
        (folder / f"agent-{agent}.jsonl").write_text(json.dumps(rec) + "\n")
        (folder / f"agent-{agent}.meta.json").write_text(json.dumps(meta))

    put("o1", "the orientation's own words", agentType="thimble:orientation")
    put("h1", "a helper's words", agentType="thimble:helper", parentAgentId="o1", description="survey")
    put("g1", "a grandchild's words", agentType="Explore", parentAgentId="h1", description="look closer")
    put("x1", "another agent's words", agentType="general-purpose", description="not ours")
    chat = agents.new_agent(CORPUS, orientation.ROLE, orientation.TITLE, route="subagent", agent_id="o1",
                            session=sid, sessions=[sid])["id"]
    digest = critique_session.chat_digest(CORPUS, chat)
    assert "the orientation's own words" in digest and "a helper's words" in digest and "a grandchild's words" in digest
    assert "another agent's words" not in digest


# --------------------------------------------------------------------------- permission requests


class Hook:
    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


async def test_a_thimble_agent_s_request_is_answered_at_once_and_its_card_has_no_buttons(bridge, models,
                                                                                       workspaces_tmp):
    from app import session

    sid = "5e55a000-0000-4000-8000-0000000000aa"
    session._live[CORPUS] = session.Live(CORPUS, sid, str(config.corpus_dir(CORPUS)), None, None)
    try:
        ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
        body = events.HookPermission(cwd=str(config.corpus_dir(CORPUS)), session=sid, tool_name="WebFetch",
                                     tool_input={"url": "https://example.com"}, agent_id=ans.agent_id)
        got = await asyncio.wait_for(events.hook_permission_route(Hook(), body), 2)
        assert got["behavior"] is None, "the terminal asks at once (U6b)"
        [card] = agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"]
        assert card["terminal"] is True and card["chat"] == subagents.agent(CORPUS, ans.agent_id)["chat"]
        events.calls_done(CORPUS, ans.agent_id, [(events.call_key("WebFetch", {"url": "https://example.com"}), 0.0)])
        assert agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"] == [], "the call ran: the terminal answered it"
        main = asyncio.ensure_future(events.hook_permission_route(Hook(), events.HookPermission(
            cwd=str(config.corpus_dir(CORPUS)), session=sid, tool_name="Edit", tool_input={"file_path": "/c/x"})))
        await asyncio.sleep(0.2)
        assert not main.done(), "main's own request waits for the analyst, as before"
        [card] = agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"]
        assert "terminal" not in card
        events.calls_done(CORPUS, None, [(events.call_key("Edit", {"file_path": "/c/x"}), time.time() + 1)])
        assert (await asyncio.wait_for(main, 2))["behavior"] is None, "answered in the terminal: the hook lets go"
        assert agents.read_meta(CORPUS, agents.MAIN_ID)["permissions"] == [], "the tool's PostToolUse closed the card"
    finally:
        session._live.pop(CORPUS, None)


def test_the_card_names_the_fence_s_rule_that_asks(monkeypatch, workspaces_tmp):
    from app import userconf

    monkeypatch.setattr(userconf, "main_rules",
                        lambda c: {"ask": [{"rule": "Edit(//data/corpus/**)", "cause": "data"},
                                           {"rule": "WebFetch", "cause": "web"}]}, raising=False)
    assert events._asked_by(CORPUS, "Edit", {"file_path": "/data/corpus/a.jsonl"}) == "data"
    assert events._asked_by(CORPUS, "WebFetch", {"url": "https://x"}) == "web"
    assert events._asked_by(CORPUS, "Bash", {"command": "ls"}) is None


def test_a_code_ticket_s_runner_reads_no_project_settings(workspaces_tmp, monkeypatch):
    """A `claude -p` job the server starts (a code ticket, `thimble fix`) runs none of the folder's own hooks, settings or
    MCP servers (U17)."""
    from app import dev, userconf

    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    flags = dev.Sessions()._flags(CORPUS, "thimble:dev · mini")
    assert flags[flags.index("--setting-sources") + 1] == "user" and "--strict-mcp-config" in flags


def test_main_s_prompt_comes_back_only_when_main_itself_compacted(tmp_path):
    from datetime import datetime, timezone

    from app import cli

    main = tmp_path / "main.jsonl"
    main.write_text(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n")
    hook = {"hook_event_name": "SessionStart", "source": "compact", "transcript_path": str(main)}
    assert not cli.main_itself(hook), "a subagent's compaction writes no boundary into main's transcript (U2)"
    now = datetime.now(timezone.utc).isoformat()
    with main.open("a") as f:
        f.write(json.dumps({"type": "system", "subtype": "compact_boundary", "timestamp": now}) + "\n")
    assert cli.main_itself(hook)
    assert cli.main_itself({**hook, "source": "clear"}), "only main clears"
    old = tmp_path / "old.jsonl"
    old.write_text(json.dumps({"type": "system", "subtype": "compact_boundary",
                               "timestamp": "2026-01-01T00:00:00+00:00"}) + "\n")
    assert not cli.main_itself({**hook, "transcript_path": str(old)}), "an earlier compaction of main's"
    assert Path(old).is_file()
