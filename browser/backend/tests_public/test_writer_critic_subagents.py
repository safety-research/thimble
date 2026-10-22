"""The writer and the critic as subagents (write_session.py, critique_session.py): Write in the browser starts a writer
through thimble's module with its context in a file its prompt names, two writers of two documents are told apart by
their request ids, and a second writer of one document is refused; the orientation's `critique` writes the digest and
the brief, records a pending critic start that only the orientation's own Agent call can claim, pauses its chat, and
finds its descendants' transcripts by `parentAgentId`. Main's permission requests wait for the analyst as before, while
a request of one of thimble's agents is answered in the terminal at once and its card has no buttons (U6b)."""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

import pytest

from app import agents, config, events, read_parts, report_types, subagents, tools, write_session
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
    assert "orient" in meta and meta["orient"] is None, "no report pass, so the browser guesses none (orientWriters)"
    again = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert again.kind == "hook", "a second writer of the document"


async def test_a_large_context_is_written_in_files_a_read_call_returns_whole(bridge, models, workspaces_tmp, monkeypatch):
    """A context past the Read tool's caps as one file (#17) is written as files of at most read_parts.READ_UNITS,
    every one named in the writer's prompt, so the writer reads each whole without tripping a cap."""
    monkeypatch.setattr(read_parts, "READ_UNITS", 1_000)
    big = "\n".join(f"line {i} " + "x" * 90 for i in range(60))  # ~6k characters: past the (patched) cap
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: big)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert ans.started
    folder = write_session.work_dir(CORPUS, "report")
    first = folder / write_session.CONTEXT_FILE
    others = sorted(folder.glob("context-*.md"), key=lambda p: int(p.stem.split("-")[1]))
    assert first.is_file() and len(others) >= 1
    paths = [first, *others]
    assert all(len(p.read_text()) <= 1_000 for p in paths)
    assert "".join(p.read_text() for p in paths) == big + "\n", "the parts are the whole context"
    [spawn] = bridge.ops("spawn")
    assert f"READ {len(paths)} FILES" in spawn["prompt"] and all(str(p) in spawn["prompt"] for p in paths)


def test_a_shrunken_context_removes_the_extra_files_of_an_earlier_one(workspaces_tmp, monkeypatch):
    monkeypatch.setattr(read_parts, "READ_UNITS", 100)
    t = {"slug": "report", "name": "Report"}
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: "x" * 350)
    assert len(write_session.write_context(CORPUS, t, "", "")) == 4
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: "y" * 50)
    paths = write_session.write_context(CORPUS, t, "", "")
    assert [p.name for p in paths] == ["context.md"]
    folder = write_session.work_dir(CORPUS, "report")
    assert sorted(p.name for p in folder.glob("context*.md")) == ["context.md"]


def test_a_full_context_file_of_dense_table_lines_is_under_the_read_file_size_cap(workspaces_tmp, monkeypatch):
    """A context file as full as read_parts.READ_UNITS lets it be, of dense table rows with characters UTF-8 writes in
    two to four bytes, is under the Read tool's file-size cap (256KB) on disk, and so is any part, at three bytes a
    UTF-16 code unit at most. The tool's other cap, 25k tokens a call, Read does not count a file of at most READ_UNITS
    code units against (test_read_parts)."""
    cap = 256 * 1024
    row = "|{i:06d}|r{i}.jsonl#L{i}|0.{i:04d}|✓|€{i}|東京|🙂|—|\n"
    text = "".join(row.format(i=i) for i in range(4 * read_parts.READ_UNITS // len(row)))
    monkeypatch.setattr(write_session.context, "render", lambda *a, **k: text)
    paths = write_session.write_context(CORPUS, {"slug": "report", "name": "Report"}, "", "")
    assert len(paths) >= 3
    full = max(read_parts.units(p.read_text("utf-8")) for p in paths)
    assert read_parts.READ_UNITS >= full > read_parts.READ_UNITS - 2 * read_parts.units(row), "as full as a part gets"
    assert all(p.stat().st_size < cap for p in paths)
    assert 3 * read_parts.READ_UNITS < cap


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


async def test_a_writer_main_s_plan_mode_caught_mid_run_fails_its_write_and_says_why(bridge, models, workspaces_tmp,
                                                                                    monkeypatch):
    """Live check L21: main went into plan mode while a writer ran, and the writer with it, so it wrote a plan file and
    no document; with the document already there, thimble took that for a revision that changed nothing. The plan_mode
    attachment in its transcript marks the run, so its end fails the write with what to do, its run and chat end
    failed with that line, main hears it failed, and a next run clears the mark."""
    seen: list[dict] = []
    told: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append(payload))
    monkeypatch.setattr(report_types, "read_doc", lambda c, inv, slug: {"sections": []})  # the document exists
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    subagents.saw_plan_mode(CORPUS, ans.agent_id)
    chat = subagents.agent(CORPUS, ans.agent_id)["chat"]
    assert agents.read_meta(CORPUS, chat)["plan_mode"] is True
    subagents.run_ended(CORPUS, ans.agent_id, "done", "I was put into plan mode partway.", source="handback")
    line = subagents.plan_failed_line("writer")
    assert line == ("Your Claude Code session went into plan mode while the writer ran, so it could not save the "
                    "document. Switch out of plan mode (shift+tab in your terminal), then write it again.")
    [end] = [r for r in seen if r.get("status") in ("generated", "failed")]
    assert end["status"] == "failed" and end["note"] == line and not end.get("unchanged")
    meta = agents.read_meta(CORPUS, chat)
    assert (meta["status"], meta["result"]) == ("failed", line)
    assert subagents.agent(CORPUS, ans.agent_id)["status"] == "failed"
    assert told == [{"text": line, "status": "failed", "doc": "report"}]
    subagents.run_again(CORPUS, ans.agent_id, "human")
    assert agents.read_meta(CORPUS, chat).get("plan_mode") is None


async def test_a_writer_that_saved_before_plan_mode_held_it_or_ran_on_after_it_ends_done(bridge, models, workspaces_tmp,
                                                                                         monkeypatch):
    """A writer whose run plan mode held at its end but which had saved its document left its work (its Type's
    left_work), and one whose transcript then said main left plan mode (plan_mode_exit) went on with it: both end
    done as before."""
    seen: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: None)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    report_types.write_pending(CORPUS, "report")["saved"] = True
    subagents.saw_plan_mode(CORPUS, ans.agent_id)
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Wrote the report.", source="handback")
    assert subagents.agent(CORPUS, ans.agent_id)["status"] == "done"
    assert [r["status"] for r in seen if r.get("status") in ("generated", "failed")] == ["generated"]
    report_types.create_document_type(CORPUS, "casefile", name="Cases", slug="cases")
    notes = await write_session.start(CORPUS, "cases", route=subagents.CLICK)
    chat = subagents.agent(CORPUS, notes.agent_id)["chat"]
    subagents.saw_plan_mode(CORPUS, notes.agent_id)
    subagents.saw_plan_mode(CORPUS, notes.agent_id, False)
    assert agents.read_meta(CORPUS, chat).get("plan_mode") is None
    assert not subagents.ended_in_plan(CORPUS, notes.agent_id)
    subagents.run_ended(CORPUS, notes.agent_id, "done", "Nothing to change.", source="handback")
    assert subagents.agent(CORPUS, notes.agent_id)["status"] == "done"


async def test_a_writer_the_analyst_stopped_ends_its_write_as_stopped_and_not_as_a_failure(bridge, models,
                                                                                           workspaces_tmp, monkeypatch):
    """Live check L4-04d: after the analyst stopped the writer on purpose, the Report showed the failure card "The
    report was not written. the writer ended without saving the document" with Retry, and a ✕ on its tab. A stopped
    writer's write ends `stopped`, with no failure, and its document stays as it was. A writer that ended without
    saving for another reason still fails, and the line that says so starts with a capital."""
    seen: list[dict] = []
    monkeypatch.setattr(report_types, "_emit", lambda c, rec: seen.append(rec))
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: None)
    ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    seen.clear()
    subagents.run_ended(CORPUS, ans.agent_id, "stopped", None, source="stop", interrupted=True)
    assert agents.read_meta(CORPUS, subagents.agent(CORPUS, ans.agent_id)["chat"])["status"] == "stopped"
    assert seen == [{"type": "report", "slug": "report", "status": "stopped", "run": None}]
    assert report_types.write_pending(CORPUS, "report") is None
    report_types.create_document_type(CORPUS, "casefile", name="Cases", slug="cases")
    unsaved = await write_session.start(CORPUS, "cases", route=subagents.CLICK)
    seen.clear()
    subagents.run_ended(CORPUS, unsaved.agent_id, "done", None, source="turn")
    [end] = seen
    assert (end["status"], end["note"]) == ("failed", "The writer ended without saving the document.")


# --------------------------------------------------------------------------- the critic


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
