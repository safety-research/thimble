"""The writer and the critic as subagents (write_session.py, critique_session.py): Write in the browser starts a writer
through thimble's module with its context in a file its prompt names, two writers of two documents are told apart by
their request ids, and a second writer of one document is refused; the orientation's `critique` writes the digest and
the brief, records a pending critic start that only the orientation's own Agent call can claim, pauses its chat, and
finds its descendants' transcripts by `parentAgentId`. Main's permission requests wait for the analyst as before, while
a request of one of thimble's agents is answered in the terminal at once and its card has no buttons (U6b)."""
from __future__ import annotations


import pytest

from app import (agents, config, read_parts, subagents, write_session)
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
