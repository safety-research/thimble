"""The document tools: `write_document` saves a whole document the writer agent wrote in markdown as its new generation
and checks its citations, and a writer run's `edit_document` calls make one new generation too. Each is called through
tools.call as the analyst's session and its agents would. No model call and no kernel."""
from __future__ import annotations

import pytest

from app import config, investigation, notebook, report_types, subagents, tools, undo, versions, write_session
from subagent_fakes import bridge  # noqa: F401 — a fixture

CORPUS = "mini"
MAIN = investigation.MAIN


@pytest.fixture()
def cells(workspaces_tmp):
    """A printed count (27) and a table-bearing card in the analyst's group."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    count = notebook.new_cell("code", "terminal", "How many deletions?", nb["id"], code="print(27)")
    count["status"], count["outputs"] = "ok", [{"text/plain": "27", "_stream": True}]
    table = notebook.new_cell("table", "terminal", "Deletions per account", nb["id"], code="df")
    table["status"] = "ok"
    table["outputs"] = [{"text/html": "<table><tr><th></th><th>count</th></tr><tr><th>alice</th><td>27</td></tr>"
                                      "<tr><th>bob</th><td>9</td></tr></table>", "text/plain": "count\nalice 27\nbob 9"}]
    nb["cells"] += [count, table]
    notebook.write_notebook(ws, nb)
    return count["id"], table["id"]


async def call(name: str, **args):
    return await tools.call(CORPUS, name, args, actor="analyst")


def _body(res) -> str:
    return res.text.partition("\n")[2]


def _events() -> list[dict]:
    return [e for e in investigation._read_jsonl(investigation.inv_dir(CORPUS, MAIN) / "events.jsonl") if e.get("type") == "report"]


async def test_write_document_saves_a_generation_and_checks_it(cells):
    cid, tid = cells
    text = (f"# One account issued every deletion\n\n## One account\n\nAll [[27|card:{cid}]] deletions came from one account. "
            f"Bob issued [[9|card:{tid}#count/bob]].\n\n![Deletions per account](card:{tid})\n![Not a chart](card:{cid})\n\n"
            "## Caveats\n\nThe log covers one week.\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc["title"] == "One account issued every deletion" and doc["generation"] == 1
    assert [s["heading"] for s in doc["sections"]] == ["One account", "Caveats"]
    first = report_types.unit_sentences(doc["sections"][0])
    assert first[0]["text"] == f"All [[27|card:{cid}]] deletions came from one account." and f"card:{cid}" in first[0]["refs"]
    assert [f["cell"] for f in doc["sections"][0]["figures"]] == [f"card:{tid}"]
    assert doc["model"] == "session" and doc["written_by"] == "terminal" and doc["words"] > 0
    assert _body(r).startswith("saved [[report:report]] as generation 1")
    assert doc["verified"]["status"] == "done", "the save checks the document's citations"
    assert _events()[-1] == {**_events()[-1], "slug": "report", "status": "generated", "by": "terminal"}
    # a second save is the next generation, the first kept in the history
    r = await call("write_document", doc="report", text="# Shorter\n\n## One account\n\nOne account did it.\n")
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert not r.is_error and doc["generation"] == 2 and doc["title"] == "Shorter"


async def test_each_revise_that_edits_passages_is_a_new_draft_and_restore_keeps_every_draft(cells, bridge, monkeypatch):
    """Revise from the sheet starts a writer that may change passages with edit_document and save nothing whole. Its
    edits are one new draft, so History keeps the draft before it. Restore adds the restored text as the newest draft,
    so the draft it replaced stays too."""
    cid, _ = cells
    monkeypatch.setattr(subagents, "tell_main", lambda *a, **k: None)
    r = await call("write_document", doc="report",
                   text=(f"# One account issued every deletion\n\n## One account\n\nAll [[27|card:{cid}]] deletions "
                         "came from one account.\n\n## Caveats\n\nThe log covers one week.\n"))
    assert not r.is_error, r.text
    first = report_types.read_doc(CORPUS, MAIN, "report")
    heading, caveat = first["sections"][0]["id"], report_types.unit_sentences(first["sections"][1])[0]["id"]

    async def revise(*edits: dict) -> str:
        """A Revise: a writer starts, makes `edits` with edit_document, and ends. Returns its chat."""
        ans = await write_session.start(CORPUS, "report", route=subagents.CLICK)
        assert ans.started, ans
        for args in edits:
            res = await tools.call(CORPUS, "edit_document", args, session=write_session.session_key("report"))
            assert not res.is_error, res.text
        subagents.run_ended(CORPUS, ans.agent_id, "done", "Revised the report.", source="handback")
        return subagents.agent(CORPUS, ans.agent_id)["chat"]

    def drafts() -> list[tuple[int, bool, int | None, str]]:
        """History's drafts, newest first: number, whether current, length and who saved it."""
        doc = report_types.read_doc(CORPUS, MAIN, "report")
        return [(v["n"], v["current"], v["words"], v["source"])
                for v in versions.history(CORPUS, MAIN, "report", doc)["versions"]]

    def text(n: int) -> list[str]:
        """Draft n's headings, then its sentences."""
        doc = versions.document_of(CORPUS, MAIN, "report", n, report_types.read_doc(CORPUS, MAIN, "report"))
        return [s["heading"] for s in doc["sections"]] + [x["text"] for x in report_types.all_sentences(doc)]

    words = report_types.doc_words(first)
    # one run's two edits are one new draft; the draft before it keeps its text
    chat = await revise({"span": f"report:report#{caveat}", "text": "The log covers one week of March."},
                        {"span": f"report:report#{heading}", "text": "A single account"})
    assert drafts() == [(2, True, words + 3, f"chat:{chat}"), (1, False, words, "first")]
    assert text(1) == ["One account", "Caveats", f"All [[27|card:{cid}]] deletions came from one account.",
                       "The log covers one week."]
    assert text(2)[:2] == ["A single account", "Caveats"] and text(2)[-1] == "The log covers one week of March."
    # the next Revise is a draft of its own
    caveat = report_types.unit_sentences(report_types.read_doc(CORPUS, MAIN, "report")["sections"][1])[0]["id"]
    await revise({"span": f"report:report#{caveat}", "text": "The log covers the first week of March."})
    assert [d[0] for d in drafts()] == [3, 2, 1] and text(2)[-1] == "The log covers one week of March."
    # Restore: Draft 1's text is the newest draft, and the drafts it replaced stay
    restored = report_types.restore_draft(CORPUS, MAIN, "report", 1)
    assert restored["generation"] == 4 and [d[0] for d in drafts()] == [4, 3, 2, 1]
    assert text(4) == text(1) and text(3)[-1] == "The log covers the first week of March."
    # Undo takes back the Restore and then the runs' edits, one step each: making a run's draft is no step
    for _ in range(3):
        undo.undo(CORPUS)
    assert report_types.read_doc(CORPUS, MAIN, "report")["generation"] == 2
    assert text(2)[0] == "One account" and text(2)[-1] == "The log covers one week of March."
