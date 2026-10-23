"""The writer and the critic as subagents (write_session.py, critique_session.py): Write in the browser starts a writer
through thimble's module with its context in a file its prompt names, two writers of two documents are told apart by
their request ids, and a second writer of one document is refused; the orientation's `critique` writes the digest and
the brief, records a pending critic start that only the orientation's own Agent call can claim, pauses its chat, and
finds its descendants' transcripts by `parentAgentId`. Main's permission requests wait for the analyst as before, while
a request of one of thimble's agents is answered in the terminal at once and its card has no buttons (U6b)."""
from __future__ import annotations


import pytest

from app import agents, config, read_parts, report_types, subagents, write_session
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


def test_a_code_ticket_s_runner_reads_no_project_settings(workspaces_tmp, monkeypatch):
    """A `claude -p` job the server starts (a code ticket, `thimble fix`) runs none of the folder's own hooks, settings or
    MCP servers (U17)."""
    from app import dev, userconf

    monkeypatch.setitem(userconf.DEFAULTS["sandbox"], "enforce", False)
    flags = dev.Sessions()._flags(CORPUS, "thimble:dev · mini")
    assert flags[flags.index("--setting-sources") + 1] == "user" and "--strict-mcp-config" in flags
