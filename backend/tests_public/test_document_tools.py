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
                                         "left out 1 figure whose card draws no figure: a figure shows a chart, a "
                                         "table, a timeline, a diagram or a custom card's page"]
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


@pytest.fixture()
def drawings(workspaces_tmp):
    """A card of each kind that draws a figure other than a plot or a table (a timeline, diagrams from a dataset and from
    code, a custom page, a card type's graphic), and a note, which draws none: {kind: id}."""
    from app.kernel_thimble import CARD_MIME, DIAGRAM_MIME, TIMELINE_MIME

    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    timeline = notebook.new_cell("timeline", "terminal", "When did the deletions happen?", nb["id"], code="thimble.timeline(evs)")
    timeline["status"] = "ok"
    timeline["outputs"] = [{TIMELINE_MIME: {"events": [{"time": "2026-06-23T20:00:00", "label": "first deletion"},
                                                       {"time": "2026-06-23T23:00:00", "label": "last deletion"}]},
                            "text/plain": "2026-06-23 20:00 first deletion\n2026-06-23 23:00 last deletion"}]
    diagram = notebook.new_cell("diagram", "terminal", "Who handed work to whom?", nb["id"],
                                payload={"dataset": {"nodes": ["alice", "bob"], "edges": [["alice", "bob", "handoff"]]}})
    drawn = notebook.new_cell("diagram", "terminal", "Which pages link?", nb["id"], code="thimble.diagram(ns, es)")
    drawn["status"] = "ok"
    drawn["outputs"] = [{DIAGRAM_MIME: {"nodes": [{"id": "a"}, {"id": "b"}], "edges": [{"source": "a", "target": "b"}]},
                         "text/plain": "a -> b"}]
    custom = notebook.new_cell("custom", "terminal", "The deletions as a strip", nb["id"], payload={"html": "<svg></svg>"})
    typed = notebook.new_cell("plot", "terminal", "The deletions in the swarm view", nb["id"], code="thimble.card('swarm')")
    typed["status"] = "ok"
    typed["outputs"] = [{CARD_MIME: {"type": "swarm", "data": {}}, "text/plain": "swarm: 2 records"}]
    note = notebook.new_cell("note", "terminal", "What we know", nb["id"], payload={"text": "The log covers one week."})
    nb["cells"] += [timeline, diagram, drawn, custom, typed, note]
    notebook.write_notebook(ws, nb)
    return {"timeline": timeline["id"], "diagram": diagram["id"], "drawn": drawn["id"], "custom": custom["id"],
            "typed": typed["id"], "note": note["id"]}


def test_a_card_that_draws_a_figure_is_one_whatever_its_kind(drawings):
    """material.figure_kind, the one test every form of document uses: a timeline or a diagram from code or from a
    dataset, a card type's graphic and a custom card's page draw a figure; a note draws none."""
    from app import material

    by_id = {c["id"]: c for nb in notebook.list_notebooks(config.workspace_dir(CORPUS))
             for c in notebook.read_notebook(config.workspace_dir(CORPUS), nb["id"])["cells"]}
    kinds = {k: material.figure_kind(by_id[cid]) for k, cid in drawings.items()}
    assert kinds == {"timeline": "timeline", "diagram": "diagram", "drawn": "diagram", "custom": "custom", "typed": "chart",
                     "note": None}
    assert material.figure_kind({"kind": "code", "outputs": [{"text/plain": "27", "_stream": True}]}) is None
    assert material.figure_kind({"kind": "custom", "payload": {"html": "  "}}) is None


async def test_a_timeline_and_a_diagram_are_a_documents_figures(drawings):
    """Matt: "why can a timeline card not be used in a document? that seems silly". A document's figure may show any card
    that draws one, in a whole save and in an inserted passage; a note is still left out, and the result says which
    cards can be figures."""
    d = drawings
    figs = "\n".join(f"![{k}](card:{d[k]})" for k in ("timeline", "diagram", "drawn", "custom", "typed", "note"))
    text = f"# Deletions\n\n## When\n\nThe deletions came in one evening [[card:{d['timeline']}]].\n\n{figs}\n"
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    shown = [f["cell"] for f in doc["sections"][0]["figures"]]
    assert shown == [f"card:{d[k]}" for k in ("timeline", "diagram", "drawn", "custom", "typed")]
    assert _body(r).splitlines()[:2] == ["saved [[report:report]] as generation 1, 1 section, 1 sentence and 5 figures",
                                         "left out 1 figure whose card draws no figure: a figure shows a chart, a "
                                         "table, a timeline, a diagram or a custom card's page"]
    # a passage inserted after the paragraph: a timeline is a figure, a note is not
    r = await call("write_document", doc="report", text=f"# Deletions\n\n## When\n\nThe deletions came in one evening.\n")
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    para = doc["sections"][0]["paragraphs"][0]["id"]
    r = await call("edit_document", span=f"report:report#p{para}", text=f"![One evening](card:{d['timeline']})", insert=True)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert [f["cell"] for f in doc["sections"][0]["figures"]] == [f"card:{d['timeline']}"]
    r = await call("edit_document", span=f"report:report#p{para}", text=f"![What we know](card:{d['note']})", insert=True)
    assert r.is_error and "draws no figure, so it cannot be one: a figure shows a chart, a table, a timeline" in r.text


@pytest.fixture()
def hours(workspaces_tmp):
    """A card of deletions per hour, its rows named by the hour, and a card that printed the first deletion's time."""
    from app import frames

    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Your work", role="analyst")
    table = notebook.new_cell("table", "terminal", "Deletions per hour on 23 June", nb["id"], code="df")
    table["status"] = "ok"
    f = frames.normalize({"columns": ["hour (UTC)", "deletions"], "index": "hour (UTC)",
                          "rows": [["20:00", 174], ["21:00", 0], ["22:00", 40], ["23:00", 89]]})
    table["outputs"] = [frames.bundle(f)]
    first = notebook.new_cell("code", "terminal", "When was the first deletion?", nb["id"], code="print(first)")
    first["status"], first["outputs"] = "ok", [{"text/plain": "2026-06-04T10:53:40Z TestFoobaAgent", "_stream": True}]
    nb["cells"] += [table, first]
    notebook.write_notebook(ws, nb)
    return table["id"], first["id"]


async def test_a_date_with_a_time_cites_a_time_stamp_and_a_flagged_sentence_is_quoted_with_why(hours):
    """Live check term-fix7, new quirk 1: `[[4 June 2026 at 10:53:40 UTC|…#L1]]` against a line holding
    2026-06-04T10:53:40Z was tagged unverified, and the save's result named the sentence by its id alone, so the writer
    replaced the sentence before it. A date with a time cites the time stamp that writes both; each flagged sentence is
    named with its words and why, in write_document's result and in edit_document's."""
    tid, fid = hours
    text = (f"# First\n\n## The first deletion\n\nThe first deletion was on [[4 June 2026 at 10:53:40 UTC|card:{fid}@out0#L1]]. "
            f"The busiest hour had [[174|card:{tid}#deletions/20:00]] deletions.\n\n"
            f"## Later\n\nA second one came at [[4 June 2026 at 11:00 UTC|card:{fid}@out0#L1]].\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    first, second = report_types.unit_sentences(doc["sections"][0])[0], report_types.unit_sentences(doc["sections"][1])[0]
    assert "unverified" not in (first.get("tags") or []), first
    assert "unverified" in second["tags"]
    lines = _body(r).splitlines()
    i = lines.index("the citation check tagged 1 sentence unverified:")
    assert lines[i + 1] == (f"- [[report:report#{second['id']}]] “A second one came at 4 June 2026 at 11:00 UTC.” Not verified by "
                            f"execution: card:{fid}@out0#L1 did not resolve to what this sentence states. The cited place "
                            "shows 2026-06-04T10:53:40Z.")
    # an edit that leaves the time wrong names the new sentence by its words, after the passage it wrote
    r = await call("edit_document", span=f"report:report#{second['id']}", text=f"Then [[4 June 2026 at 10:54 UTC|card:{fid}@out0#L1]] came.")
    assert not r.is_error, r.text
    body = _body(r).splitlines()
    assert body[0].startswith("replaced [[report:report#") and body[0].endswith(f": Then [[4 June 2026 at 10:54 UTC|card:{fid}@out0#L1]] came.")
    assert body[1] == "the citation check tagged 1 sentence unverified:"
    assert body[2].startswith("- [[report:report#") and body[2].endswith("“Then 4 June 2026 at 10:54 UTC came.” Not verified by "
                                                                       f"execution: card:{fid}@out0#L1 did not resolve to "
                                                                       "what this sentence states. The cited place shows "
                                                                       "2026-06-04T10:53:40Z.")


async def test_a_value_cited_at_the_row_its_sentence_names_stays_there(hours):
    """Live check term-fix7, new quirk 1: the writer cited `[[89|…#deletions/22:00]]` "in the 22:00 hour", the 22:00 row
    showed 40, and the save moved the citation to 23:00, the one row showing 89, so a wrong hour stood under a blue
    link. A value whose sentence names the row it cites stays at that row, and the sentence is tagged with what the row
    shows; one whose sentence names no row still moves to the one place that shows it."""
    tid, _ = hours
    text = (f"# Hours\n\n## Hours\n\nA last [[89|card:{tid}#deletions/22:00]] came in the 22:00 hour.\n\n"
            f"## Other\n\nThe evening ended with [[89|card:{tid}#deletions/22:00]] deletions.\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    named, other = report_types.unit_sentences(doc["sections"][0])[0], report_types.unit_sentences(doc["sections"][1])[0]
    assert f"[[89|card:{tid}#deletions/22:00]]" in named["text"] and "unverified" in named["tags"]
    assert "The cited place shows 40." in named["tag_notes"]["unverified"]
    assert f"[[89|card:{tid}#deletions/23:00]]" in other["text"] and "unverified" not in (other.get("tags") or [])
    assert f"“A last 89 came in the 22:00 hour.” Not verified by execution" in r.text


async def test_the_title_has_an_id_the_writer_edits_and_no_section_takes_a_headline(cells):
    """Live check term-fix9, quirk 2: asked to change the headline, the writer called edit_document on the first section
    (no heading) with `# …`, and the report showed two headlines, since read_ref gave the title no id. The title's line
    names it `#title`; edit_document replaces it there (its marks dropped, the former title in its history), refuses
    any other edit of it, refuses a `# ` line on a section or a passage, and leaves a locked title as it was."""
    cid, _ = cells
    text = (f"Opening words without a heading, with [[27|card:{cid}]] deletions.\n\n"
            "## One account\n\nOne account did it.\n")
    r = await call("write_document", doc="report", text=f"# One account issued every deletion\n\n{text}")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    lines = report_types.document_lines(doc)
    assert lines[0] == "# One account issued every deletion · #title"
    first = doc["sections"][0]
    # a `# ` line on the first section (a heading) or on a sentence: refused, pointing to the title
    for span in (f"report:report#{first['id']}", f"report:report#{report_types.unit_sentences(first)[0]['id']}"):
        r = await call("edit_document", span=span, text="# A sharper headline")
        assert r.is_error and "report:report#title" in r.text, r.text
    assert len(report_types.document_lines(report_types.read_doc(CORPUS, MAIN, "report"))) == len(lines)
    # the title, by its id, with the marks read_ref writes copied back
    r = await call("edit_document", span="report:report#title", text="# A sharper headline · #title")
    assert not r.is_error and "replaced the title [[report:report#title]]: A sharper headline" in r.text, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc["title"] == "A sharper headline" and doc["title_history"][-1]["text"] == "One account issued every deletion"
    assert [s.get("heading") for s in doc["sections"]] == [first.get("heading"), "One account"]
    assert report_types.document_lines(doc)[0] == "# A sharper headline · #title"
    for extra in ({"delete": True}, {"insert": True}, {"layout": "title"}):
        r = await call("edit_document", span="report:report#title", text="x", **extra)
        assert r.is_error and "is the title" in r.text, (extra, r.text)
    # a locked title is refused, and read_ref's lines say so
    report_types.set_block_lock(CORPUS, MAIN, "report", report_types.TITLE_BLOCK, True)
    r = await call("edit_document", span="report:report#title", text="Another headline")
    assert r.is_error and "locked" in r.text.lower(), r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc["title"] == "A sharper headline"
    assert report_types.document_lines(doc)[0] == "# A sharper headline · #title · locked"
    # a whole document saved with read_ref's title line copied keeps the title's words alone
    report_types.set_block_lock(CORPUS, MAIN, "report", report_types.TITLE_BLOCK, False)
    r = await call("write_document", doc="report", text=f"# Copied headline · #title\n\n{text}")
    assert not r.is_error, r.text
    assert report_types.read_doc(CORPUS, MAIN, "report")["title"] == "Copied headline"
