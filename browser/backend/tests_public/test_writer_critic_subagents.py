"""The writer as a subagent (write_session.py): Write in the browser starts a writer through thimble's module with its
context in a file its prompt names, a second writer of one document is refused, and the writer's end tells main. The
module is the fake bridge (subagent_fakes)."""
from __future__ import annotations

import pytest

from app import agents, config, subagents, write_session
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"


@pytest.fixture()
def models(monkeypatch):
    rows = {"writer": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})


async def test_write_starts_the_writer_with_its_context_file_and_its_end_tells_main(bridge, models, workspaces_tmp,
                                                                                     monkeypatch):
    told: list[tuple] = []
    monkeypatch.setattr(subagents, "tell_main", lambda c, kind, payload: told.append((kind, payload)))
    ans = await write_session.start(CORPUS, "report", "Shorter, please.", route=subagents.CLICK)
    assert ans.started
    [spawn] = bridge.ops("spawn")
    path = write_session.work_dir(CORPUS, "report") / write_session.CONTEXT_FILE
    assert path.is_file() and "report:report" in path.read_text() and "Shorter, please." in path.read_text()
    assert f"READ {path} FIRST" in spawn["prompt"] and spawn["values"] == {"model": "claude-opus-5-5", "effort": "high"}
    assert spawn["description"] == "writer: report" and spawn["what"] == "report"
    meta = agents.read_meta(CORPUS, subagents.agent(CORPUS, ans.agent_id)["chat"])
    assert meta["role"] == "writer" and meta["doc"] == "report"
    again = await write_session.start(CORPUS, "report", route=subagents.CLICK)
    assert again.kind == "hook", "a second writer of the document"
    subagents.run_ended(CORPUS, ans.agent_id, "done", "Wrote the report.", source="handback")
    assert told == [(write_session.WRITTEN_KIND, {"text": "Wrote the report.", "status": "done", "doc": "report"})]
