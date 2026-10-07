"""The document tools: `write_document` saves a whole document the writer agent wrote in markdown as its new generation
and checks it, called through tools.call as the analyst's session and its agents would. No model call and no kernel."""
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


async def test_write_document_reads_a_citation_written_in_one_pair_of_brackets(cells):
    """Live check term-fix7: the writer wrote `[23 June|card:<id>#day/06-23]`, and the document showed it as written. A
    document's citation forms are put right as a takeaway's are (cite.normalise_markup): one pair of brackets, a
    Markdown link to a ref, and `[[↗|ref]]` for a place alone."""
    cid, tid = cells
    text = (f"# Bob\n\n## Bob\n\nBob issued [9|card:{tid}#count/bob] deletions, all [27](card:{cid}) came from one account "
            f"[[↗|card:{tid}]].\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    [first] = report_types.unit_sentences(doc["sections"][0])
    assert first["text"] == f"Bob issued [[9|card:{tid}#count/bob]] deletions, all [[27|card:{cid}]] came from one account [[card:{tid}]]."
