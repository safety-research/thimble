"""The report's reader in the terminal panel (app/term_report.py, plugin/hooks/term report.ts): `thimble state checks`
gives the checks route's list, and `thimble act comment-resolve` and `comment-reopen` change a comment as the margin's ✓
does. The reader is read-only: the report is written and edited in the browser workbench, so there is no `doc-save`."""
from __future__ import annotations

import json

import pytest

from app import cardrun, config, investigation, local, notebook, report_types, tools

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def doc(workspaces_tmp, mini_dir, monkeypatch) -> dict:
    """A terminal-mode workspace with a report of two sections, a check's comment on a sentence of the first, a note of
    Claude's on the second section's heading, and a resolved comment."""
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    ws = config.workspace_dir(CORPUS)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": "terminal"}))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    nb["cells"].append(count)
    notebook.write_notebook(ws, nb)
    text = (f"# One account issued every deletion\n\n## One account\n\nAll [[27|card:{count['id']}]] deletions came from one "
            "account. The log covers one week.\n\n## Caveats\n\nNothing before June.\n")

    async def write() -> None:
        r = await tools.call(CORPUS, "write_document", {"doc": "report", "text": text}, actor="analyst")
        assert not r.is_error, r.text

    import asyncio

    asyncio.run(write())
    d = report_types.read_doc(CORPUS, MAIN, "report")
    first, second = d["sections"]
    s1, s2 = report_types.unit_sentences(first)
    d["comments"] = [
        {"id": "c1", "sentence_id": s2["id"], "text": "Which week?", "check": "judgment", "status": "open"},
        {"id": "c2", "sentence_id": second["id"], "text": "Say what came before.", "author": "claude", "status": "open"},
        {"id": "c3", "sentence_id": s1["id"], "text": "Checked.", "check": "verified", "status": "dismissed"},
    ]
    report_types.write_doc(CORPUS, MAIN, "report", d)
    yield d
    cardrun.CardWatch.stop_all()
    local._started.clear()


def _comments() -> dict[str, dict]:
    return {cm["id"]: cm for cm in report_types.read_doc(CORPUS, MAIN, "report")["comments"]}


async def test_act_resolves_and_reopens_a_comment_as_the_margin_does(doc):
    got = await local.act(CORPUS, "comment-resolve", {"doc": "report", "comment": "c1"})
    assert got == {"ok": True, "doc": "report", "comment": "c1", "status": "dismissed"}
    assert _comments()["c1"]["status"] == "dismissed"
    got = await local.act(CORPUS, "comment-reopen", {"doc": "report:report", "comment": "c3"})
    assert got["status"] == "open" and _comments()["c3"]["status"] == "open"
    with pytest.raises(local.StateError, match="no such comment"):
        await local.act(CORPUS, "comment-resolve", {"doc": "report", "comment": "nope"})
    with pytest.raises(local.StateError, match="`comment` is empty"):
        await local.act(CORPUS, "comment-resolve", {"doc": "report"})
    with pytest.raises(local.StateError, match="`doc` is empty"):
        await local.act(CORPUS, "comment-reopen", {"comment": "c1"})
    assert "comment-resolve" in local.ACT_USAGE and "doc-save" not in local.ACT_USAGE
    with pytest.raises(local.StateError, match="no act 'doc-save'"):
        await local.act(CORPUS, "doc-save", {"doc": "report", "blocks": []})
