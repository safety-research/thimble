"""The card tools in app.tools: add_card runs its code on the kernel and reports the output, called through tools.call
as a browser chat running as the analyst."""
from __future__ import annotations

import json
import re

import pytest

from app import config, notebook, tools

CORPUS = "mini"


@pytest.fixture(autouse=True)
async def _stack(workspaces_tmp, monkeypatch):
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):  # no interface to shoot a card in, unless a test says
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def group() -> str:
    """The caller's own group, which its calls name as their notebook (tools.Ctx.notebook), where its cards land when a
    call names no group (tools.default_group)."""
    return notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]


async def call(name: str, nb: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False)


def _cid(result) -> str:
    """The card a result names on its own line (the call line and the takeaway reminder for the card before come first)."""
    assert not result.is_error, result.text
    hit = next((m.group(1) for line in result.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, result.text
    return hit


async def test_add_card_runs_its_code_reports_the_output_and_asks_for_a_takeaway(group):
    r = await call("add_card", group, kind="code", question="How many?", code="print(3)")
    cid = _cid(r)
    assert r.text.splitlines()[0] == '$ add_card kind="code" question="How many?" code="print(3)"'
    assert "L1|3" in r.text
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["kind"] == "code" and cell["title"] == "How many?" and cell["created_by"] == "chat" and cell["notebook"] == group
    assert cell["status"] == "ok"
    assert r.text.rstrip().endswith(tools.hint("takeaway-missing", cid=cid))
    await call("edit_card", group, cell=cid, takeaway="Three.")
    assert notebook.get_cell(CORPUS, cid)["takeaway"] == "Three."
    # a card whose code fails shows its error; an empty question is refused before anything runs
    err = notebook.get_cell(CORPUS, _cid(await call("add_card", group, question="Errors?", code="raise ValueError('x')")))
    assert err["status"] == "error" and "ValueError" in str(err["outputs"])
    assert (await call("add_card", group, code="print(1)")).is_error


async def test_a_plan_card_kept_from_before_reads_as_a_note_of_its_steps(group):
    """A workspace from thimble 0.10.11 or before may hold plan cards, a kind that is gone: one reads as a note that
    lists its steps with their statuses, and main reads it as any note."""
    path = config.workspace_dir(CORPUS) / "notebooks" / f"{group}.json"
    stored = json.loads(path.read_text())
    steps = [{"id": "s1", "text": "Mirror the repos", "status": "done"}, {"id": "s2", "text": "Run both conditions",
                                                                         "status": "running"}]
    stored["cells"].append({"id": "p1an0001", "kind": "plan", "title": "Plan: build the environment and pilot it",
                            "takeaway": "", "payload": {"steps": steps, "follows": None},
                            "edited": [{"id": "e1", "ts": "2026-10-08T12:00:00+00:00", "fields": ["payload"]}]})
    path.write_text(json.dumps(stored))
    notebook.clear_cache()
    cell = notebook.get_cell(CORPUS, "p1an0001")
    assert cell["kind"] == "note" and cell["edited"] == []
    assert cell["payload"] == {"text": "1. Mirror the repos (done)\n2. Run both conditions (running)"}
    assert "1. Mirror the repos (done)" in (await call("read_ref", group, ref="card:p1an0001")).text
