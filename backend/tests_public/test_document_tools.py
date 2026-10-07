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


async def test_a_number_or_a_span_of_time_in_the_title_or_a_heading_that_no_link_shows_is_named(cells):
    """Live check term-fix8: the title said "for seven weeks" and a slide heading "seven weeks before the busiest days",
    40 days in the data, and the citation check, which read only sentences, said nothing. A save names the title and
    each heading that writes a number, a span of time or a date no link shows, a link of its own section for a heading
    and of the whole document for the title, in the form of the flagged sentences; an edit of the title or a heading
    names it again while it holds one. The analyst's locked title is left out."""
    cid, tid = cells
    text = (f"# The account deleted for seven weeks, 27 times\n\n"
            f"## Bob issued 9 deletions on 23 June\n\nBob issued [[9|card:{tid}#count/bob]] deletions.\n\n"
            f"## A gap of 40 days\n\nThe log is short.\n\n"
            f"## Alice issued 27 over two weeks\n\nAll [[27|card:{cid}]] came from Alice, over [[two weeks|card:{cid}]].\n\n"
            f"## One account, three accounts\n\nOne account did most of it.\n")
    r = await call("write_document", doc="report", text=text)
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    bob, gap, alice, _ = doc["sections"]
    lines = _body(r).splitlines()
    i = lines.index("the citation check found a number or a span of time that no link shows in 3 headings:")
    assert lines[i + 1:] == [
        "- [[report:report#title]] “The account deleted for seven weeks, 27 times” No link in the document shows “seven "
        "weeks”. Cite it in a sentence, compute it in a card first if no card states it, or reword the title, before you end. "
        "A link in the title itself is not checked.",
        f"- [[report:report#{bob['id']}]] “Bob issued 9 deletions on 23 June” No link in its section shows “23 June”. Cite "
        "it in a sentence, compute it in a card first if no card states it, or reword the heading, before you end. A link "
        "in the heading itself is not checked.",
        f"- [[report:report#{gap['id']}]] “A gap of 40 days” No link in its section shows “40 days”. Cite it in a sentence, "
        "compute it in a card first if no card states it, or reword the heading, before you end. A link in the heading "
        "itself is not checked."]
    assert all(alice["id"] not in ln for ln in lines), "27 and two weeks are shown by its links"
    # an edit of the title that still says what no link shows is named again; a heading made plain is not
    r = await call("edit_document", span="report:report#title", text="The account deleted for 40 days")
    assert not r.is_error and "No link in the document shows “40 days”" in r.text, r.text
    r = await call("edit_document", span=f"report:report#{gap['id']}", text="A gap in the log")
    assert not r.is_error and "no link shows" not in r.text, r.text
    r = await call("edit_document", span=f"report:report#{bob['id']}", text="Bob issued 9 deletions")
    assert not r.is_error and "no link shows" not in r.text, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert [x[0] for x in report_types.loose_headings(doc)] == ["title"]
    doc["title_locked"] = True
    assert report_types.loose_headings(doc) == [], "the analyst's locked title"
    # live check dec-back: a span written with a hyphen, as the writer's title "… in a six-week span, June 4 to July 14"
    assert report_types._claims_of("All in a six-week span, June 4 to July 14, 2026") == [
        ("date", "June 4", "June 4"), ("date", "July 14, 2026", "July 14, 2026"), ("span", "six-week", "6")]


async def test_the_report_checks_read_the_title_as_a_passage_and_its_comment_stays_while_its_words_do(cells):
    """The report checks (Verified, Unverified, Judgment calls) read the title as a passage at report:<slug>#title,
    first, and a comment on it carries to the next generation while the title's words stay; a new title settles a
    check's comment on the old one."""
    from app import checks

    cid, _ = cells
    r = await call("write_document", doc="report", text=f"# The account deleted for seven weeks\n\n## One account\n\nAll "
                                                         f"[[27|card:{cid}]] came from one account.\n")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    first = checks.passages("report", doc)[0]
    assert (first["ref"], first["kind"], first["anchor"], first["ids"]) == ("report:report#title", "title", "title", ["title"])
    assert checks.passage_of("report", doc, "report:report#title") == first
    doc["comments"] = [{"id": "c1", "sentence_id": "title", "text": "No card shows seven weeks.", "check": "unverified",
                        "status": "open", "generation": 1}]
    report_types.write_doc(CORPUS, MAIN, "report", doc)
    assert [cm["id"] for cm in report_types.anchored_open_comments(doc)] == ["c1"]
    r = await call("write_document", doc="report", text=f"# The account deleted for seven weeks\n\n## One account\n\nIt "
                                                         f"was [[27|card:{cid}]] deletions.\n")
    [cm] = report_types.read_doc(CORPUS, MAIN, "report")["comments"]
    assert cm["sentence_id"] == "title" and cm["status"] == "open"
    r = await call("edit_document", span="report:report#title", text="One account deleted everything")
    [cm] = report_types.read_doc(CORPUS, MAIN, "report")["comments"]
    assert cm["status"] != "open" and cm["was_on"] == "The account deleted for seven weeks"


async def test_edit_document_refuses_a_figure_line_among_sentences(cells):
    """Live check term-fix10, quirk 1: the writer replaced a sentence with "sentence.\\n![…](card:…)", and the report
    showed the figure's markdown inside a paragraph, since only a text that opens with a figure was refused. A figure's
    markup anywhere in a passage's text but as its one line is refused with what to do; a figure line alone is
    inserted, and a new section reads its figure lines as figures."""
    cid, tid = cells
    r = await call("write_document", doc="report", text=f"# Bob\n\n## Bob\n\nBob issued [[9|card:{tid}#count/bob]] deletions.\n")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    [sid] = [x["id"] for x in report_types.unit_sentences(doc["sections"][0])]
    for text, insert in [(f"Bob issued nine.\n![Deletions per account](card:{tid})", False),
                         (f"![Deletions per account](card:{tid})\nBob issued nine.", True),
                         (f"Bob issued nine, as ![the table](card:{tid}) shows.", False)]:
        r = await call("edit_document", span=f"report:report#{sid}", text=text, **({"insert": True} if insert else {}))
        assert r.is_error and report_types.FIGURE_WITH_TEXT in r.text, r.text
    after = report_types.read_doc(CORPUS, MAIN, "report")
    assert "![" not in " ".join(x["text"] for x in report_types.all_sentences(after))
    r = await call("edit_document", span=f"report:report#{sid}", text=f"![Deletions per account](card:{tid})", insert=True)
    assert not r.is_error, r.text
    r = await call("edit_document", span=f"report:report#{sid}", insert=True,
                   text=f"## Alice\n\nAll [[27|card:{cid}]] came from Alice.\n\n![Deletions per account](card:{tid})")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert [len(s.get("figures") or []) for s in doc["sections"]] == [1, 1]


async def test_a_replaced_sentence_that_repeats_its_neighbor_is_left_out(cells):
    """Live check term-fix10, quirk 2: the writer twice replaced a sentence with "A. B." while B already followed it, and
    the report showed B three times. A new sentence at the end of the text that reads as the sentence after the passage
    (or at its start as the one before) is left out, and the result says so; a text that only repeats them is refused."""
    _, tid = cells
    r = await call("write_document", doc="report", text=f"# Bob\n\n## Bob\n\nBob issued deletions. Alpha paused the probe "
                                                       f"on 26 June [[card:{tid}]].\n")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    first, second = report_types.unit_sentences(doc["sections"][0])
    r = await call("edit_document", span=f"report:report#{first['id']}",
                   text=f"Bob issued [[9|card:{tid}#count/bob]] deletions. Alpha paused the probe on 26 June [[card:{tid}]].")
    assert not r.is_error, r.text
    assert "left out “Alpha paused the probe on 26 June.”, since the sentence next to the passage already says it" in r.text
    words = [report_types.plain_text(x["text"]) for x in report_types.unit_sentences(report_types.read_doc(CORPUS, MAIN, "report")["sections"][0])]
    assert words == ["Bob issued 9 deletions.", "Alpha paused the probe on 26 June."]
    new_first = report_types.unit_sentences(report_types.read_doc(CORPUS, MAIN, "report")["sections"][0])[0]
    r = await call("edit_document", span=f"report:report#{new_first['id']}", text="alpha paused the probe on 26 June.")
    assert r.is_error and "pass `delete`" in r.text, r.text


async def test_a_first_save_with_a_section_heading_and_no_title_line_shows_the_headline_once(cells):
    """Live check term-fix10, quirk 3: the first save wrote `## headline` and no `# ` line, the title fell back to that
    heading, and the section kept it too, so the headline was drawn twice. The section becomes the opening."""
    cid, _ = cells
    r = await call("write_document", doc="report", text=f"## One account issued every deletion\n\nAll [[27|card:{cid}]] "
                                                       f"came from one account.\n\n## Caveats\n\nThe log covers one week.\n")
    assert not r.is_error, r.text
    doc = report_types.read_doc(CORPUS, MAIN, "report")
    assert doc["title"] == "One account issued every deletion"
    assert [s["heading"] for s in doc["sections"]] == ["", "Caveats"]
    lines = report_types.document_lines(doc)
    assert sum("One account issued every deletion" in ln for ln in lines) == 1
