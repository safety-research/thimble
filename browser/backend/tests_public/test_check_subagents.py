"""Report checks as subagents of main (checks.py): a writer's end starts each shown check on its document through
thimble's module, as a follow-on start of the writer's own, each with its task file in check-work/, and a run's end
records what it did. The module is the fake bridge (subagent_fakes); an agent's end is subagents.run_ended."""
from __future__ import annotations

import asyncio

import pytest

from app import agents, checks, config, subagents, tools
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
TEXT = ("# One account did it\n\n## One account\n\nAll the deletions came from one account. It ran at night.\n\n"
        "## Caveats\n\nThe log covers one week.\n")


@pytest.fixture()
def doc(workspaces_tmp, monkeypatch):
    """The checks `explainers` and `judgment` on, on Settings' checks row; each test writes the report (_write)."""
    _checks_row(monkeypatch)
    for cid in ("explainers", "judgment"):
        checks.edit(CORPUS, cid, shown=True)
    checks.edit(CORPUS, "heads-up", shown=False)  # Heads up starts on: these two are the shown checks


def _checks_row(monkeypatch) -> None:
    rows = {"checks": {"model": "claude-opus-5-5", "effort": "high", "fast": False}}
    real = config.models_for
    monkeypatch.setattr(config, "models_for", lambda c=None: {**real(c), **{k: dict(v) for k, v in rows.items()}})


async def _write(text: str = TEXT) -> None:
    r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
    assert not r.is_error, r.text


async def _until(cond, what: str) -> None:
    for _ in range(300):
        if cond():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(what)


def _run(cid: str, docname: str = "report") -> dict:
    return ((checks.read(CORPUS, cid) or {}).get("runs") or {}).get(docname) or {}


def _writer_done(docname: str = "report") -> None:
    meta = agents.new_agent(CORPUS, "writer", f"Write {docname}", doc=docname, announce=False)
    agents.finish_agent(CORPUS, meta["id"], "done", "Wrote it.")


async def test_a_writer_s_end_starts_each_shown_check_through_the_module_with_its_task_file(doc, bridge):
    await _write()
    assert not bridge.ops("spawn"), "a save starts nothing"
    _writer_done()
    await _until(lambda: len(bridge.ops("spawn")) == 2, "the shown checks did not start at the writer's end")
    assert sorted(s["what"] for s in bridge.ops("spawn")) == ["explainers on report", "judgment on report"]
    for spawn in bridge.ops("spawn"):
        cid = spawn["what"].split()[0]
        path = checks.work_dir(CORPUS, cid, "report") / checks.TASK_FILE
        assert path.is_file() and "report:report" in path.read_text()
        assert str(path) in spawn["prompt"] and spawn["role"] == "check"
        assert subagents.request(CORPUS, spawn["request"])["route"] == "follow-on"
        assert agents.read_meta(CORPUS, _run(cid)["chat"])["check"] == cid
    agent = _run("explainers")["agent_id"]
    subagents.run_ended(CORPUS, agent, "done", "Commented on 0 of 3 passages.", source="handback")
    await _until(lambda: _run("explainers").get("status") == "done", "the run never ended")
    assert _run("explainers")["summary"] == "Commented on 0 of 3 passages."
