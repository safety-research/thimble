"""The document tools: `write_document` saves a whole document
the writer agent wrote in markdown as its new generation, and `edit_document` replaces one passage or inserts a
paragraph or a figure after it. Both run in report_types (tool_write_document, tool_edit_document) and are called here
through tools.call as the analyst's session and its agents would. No model call and no kernel.
"""
from __future__ import annotations

import pytest

from app import config, investigation, notebook, report_types, tools

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


def test_markdown_reads_as_the_writers_output():
    raw = report_types.parse_markdown(
        "# One account issued every deletion\n\nAn opening line.\n\n## What happened\n\nFirst paragraph.\n\nSecond "
        "paragraph.\n![Per account](card:t1)\n\n### A finding\n\n![Before any text](card:t2)\nText after.\n", "document")
    assert raw["title"] == "One account issued every deletion"
    assert [s["heading"] for s in raw["sections"]] == ["", "What happened", "A finding"]
    assert raw["sections"][0]["body"] == "An opening line."
    assert raw["sections"][1]["figures"] == [{"cell": "card:t1", "caption": "Per account", "after_paragraph": 2}]
    assert raw["sections"][2]["figures"] == [{"cell": "card:t2", "caption": "Before any text", "after_paragraph": None}]
    assert "![" not in raw["sections"][1]["body"]
    assert report_types.parse_markdown("No title here.", "document")["title"] == ""


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
    assert _body(r).splitlines()[:2] == ["saved [[report:report]] as generation 1, 2 sections, 3 sentences and 1 figure",
                                         "left out 1 figure whose card shows no chart or table"]
    assert tools.hint("write_document-saved", slug="report") in r.text and doc["verified"]["status"] == "done"
    assert _events()[-1] == {**_events()[-1], "slug": "report", "status": "generated", "by": "terminal"}
    # a second save is the next generation, the first kept in the history
    r = await call("write_document", doc="report", text="# Shorter\n\n## One account\n\nOne account did it.\n")
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert not r.is_error and doc["generation"] == 2 and doc["title"] == "Shorter"


async def test_write_document_refuses_what_it_cannot_save(cells):
    d = config.workspace_dir(CORPUS) / "report-types" / "memo"
    d.mkdir(parents=True)
    (d / "type.json").write_text('{"slug": "memo", "name": "Memo", "renderer": "custom", "schema": {"type": "object"}}')
    r = await call("write_document", doc="memo", text="# A memo\n\n## Point\n\nText.\n")
    assert r.is_error and _body(r) == tools.hint("write_document-form", doc="memo")
    r = await call("write_document", doc="nope", text="# T\n\nx.")
    assert r.is_error and "report" in r.text
    assert (await call("write_document", doc="report", text="  ")).is_error
    assert (await call("write_document", text="# T")).is_error
    r = await call("write_document", doc="report", text="# Only a title\n")
    assert r.is_error and report_types.read_doc(CORPUS, MAIN, "report") is None


async def _written(cid: str, tid: str) -> dict:
    await call("write_document", doc="report", text=(
        f"# One account issued every deletion\n\n## One account\n\nAll [[27|card:{cid}]] deletions came from one account. "
        "The operator meant to hide the change.\n\n## Caveats\n\nThe log covers one week.\n"))
    return report_types.read_doc(CORPUS, MAIN, "report")


async def test_edit_document_replaces_one_passage_and_leaves_the_locks_to_the_analyst(cells):
    cid, tid = cells
    doc = await _written(cid, tid)
    sentences = report_types.unit_sentences(doc["sections"][0])
    sid = sentences[1]["id"]
    r = await call("edit_document", span=f"report:report#{sid}", text="The log shows the change. It says nothing of motive.")
    assert not r.is_error, r.text
    after = report_types.read_doc(CORPUS, MAIN, "report")
    texts = [x["text"] for x in report_types.unit_sentences(after["sections"][0])]
    assert texts == [sentences[0]["text"], "The log shows the change.", "It says nothing of motive."]
    new_ids = [x["id"] for x in report_types.unit_sentences(after["sections"][0])][1:]
    assert report_types.locked_refs(after, "report") == []  # an agent's edit is not a lock
    hist = after["sections"][0]["paragraphs"][0]["history"][-1]
    assert hist == {**hist, "text": "The operator meant to hide the change.", "by": "edit", "actor": "terminal"}
    assert all(f"[[report:report#{i}]]" in r.text for i in new_ids), "the result names the passage's new refs"
    assert _events()[-1] == {**_events()[-1], "status": "rewritten", "span": f"report:report#{sid}"}
    # the analyst's own edit locks nothing either (only what they lock is locked), so a later save that leaves it out
    # has it out, and names no lock
    await report_types.edit_sentence(CORPUS, MAIN, "report", new_ids[0], report_types.SentenceEdit(text="The log shows the change, and when."))
    r = await call("write_document", doc="report", text="# Again\n\n## One account\n\nOne account did it.\n")
    assert not r.is_error and "locked" not in r.text
    texts = [x["text"] for x in report_types.all_sentences(report_types.read_doc(CORPUS, MAIN, "report"))]
    assert texts == ["One account did it."]
    r = await call("edit_document", span="report:report#nope", text="x.")
    assert r.is_error and "nope" in r.text
    assert (await call("edit_document", span="not a span", text="x.")).is_error


async def test_edit_document_replaces_a_heading(cells):
    """read_ref offers a heading's id for editing as it does a sentence's, so edit_document replaces a section heading
    by that id, not locked and with the former heading in its history."""
    cid, tid = cells
    doc = await _written(cid, tid)
    uid = doc["sections"][0]["id"]
    listed = (await call("read_ref", ref="report:report")).text
    assert f"## One account · #{uid}" in listed
    r = await call("edit_document", span=f"report:report#{uid}", text="## Every deletion came from one account")
    assert not r.is_error, r.text
    after = report_types.read_doc(CORPUS, MAIN, "report")
    sec = after["sections"][0]
    assert sec["heading"] == "Every deletion came from one account" and report_types.locked_refs(after, "report") == []
    assert sec["history"][-1] == {**sec["history"][-1], "text": "One account", "by": "edit", "actor": "terminal"}
    assert report_types.unit_sentences(sec)[0]["text"] == f"All [[27|card:{cid}]] deletions came from one account."
    assert _events()[-1] == {**_events()[-1], "status": "rewritten", "span": f"report:report#{uid}"}
    assert (await call("edit_document", span=f"report:report#{uid}", text="Two lines.\n\nOf heading.")).is_error


async def test_edit_document_inserts_a_paragraph_or_a_figure_after_a_passage(cells):
    cid, tid = cells
    doc = await _written(cid, tid)
    pid = doc["sections"][0]["paragraphs"][0]["id"]
    r = await call("edit_document", span=f"report:report#p{pid}", text=f"Bob issued [[9|card:{tid}#count/bob]] of them.", insert=True)
    assert not r.is_error, r.text
    paras = report_types.read_doc(CORPUS, MAIN, "report")["sections"][0]["paragraphs"]
    assert len(paras) == 2 and paras[1]["sentences"][0]["text"] == f"Bob issued [[9|card:{tid}#count/bob]] of them."
    assert f"[[report:report#p{paras[1]['id']}]]" in r.text
    # a figure is a passage of its own, inserted after the passage the span names
    sid = paras[1]["sentences"][0]["id"]
    r = await call("edit_document", span=f"report:report#{sid}", text=f"![Deletions per account](card:{tid})", insert=True)
    assert not r.is_error, r.text
    figs = report_types.read_doc(CORPUS, MAIN, "report")["sections"][0]["figures"]
    assert [(f["cell"], f["caption"], f["after_paragraph"]) for f in figs] == [(f"card:{tid}", "Deletions per account", paras[1]["id"])]
    r = await call("edit_document", span=f"report:report#{sid}", text=f"![A count](card:{cid})", insert=True)
    assert r.is_error and "no chart or table" in r.text
    r = await call("edit_document", span=f"report:report#{sid}", text=f"![Per account](card:{tid})")
    assert r.is_error and "`insert`" in r.text
