"""The card tools in app.tools: add_card (kinds, payloads, the kind check, groups), edit_card (a re-run in place, and a
takeaway checked against the new output), delete_card (a card a document cites is kept), list_cards, and a chart's rows
in every result that shows the card, so its numbers reach the model without a table on the canvas.

Every test calls through tools.call as a browser chat running as the analyst with an explicit group. No model writes a
takeaway: the agent that ran a card writes it with edit_card, and a clean card's result says when it has none.
"""
from __future__ import annotations

import json
import re

import pytest

from app import config, notebook, refs, tools

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
    """The caller's own group, made the way tools.analyst_notebook would."""
    return notebook.create_notebook(config.workspace_dir(CORPUS), "Your work", role="analyst")["id"]


async def call(name: str, nb: str, anchor: str | None = None, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", notebook=nb, terminal=False, anchor=anchor)


def _cid(result) -> str:
    """The card a result names on its own line (the call line and the takeaway reminder for the card before come first)."""
    assert not result.is_error, result.text
    hit = next((m.group(1) for line in result.text.splitlines() if (m := re.fullmatch(r"card:([A-Za-z0-9_-]+)", line.strip()))), None)
    assert hit, result.text
    return hit


def _body(result) -> str:
    """A result's text after its first line, the call as run (`$ add_card kind="note" ...`; tools.call_line)."""
    first, _, rest = result.text.partition("\n")
    assert first.startswith("$ "), result.text
    return rest


SHAPES = ("chart", "image", "table", "text", "none", "error")  # what tools._output_shape can name


def _mismatch(result, kind: str) -> bool:
    """Whether a result carries the kind-mismatch hint for its card, whatever shape it names (the hint's text comes from
    prompts/tools.md, so no test pins its wording)."""
    cid = _cid(result)
    return any(tools.hint("kind-mismatch", cid=cid, kind=kind, shape=s) in result.text for s in SHAPES)


# ----------------------------------------------------------------------------------------------------------
# add_card


async def test_add_cell_runs_code_and_reports_the_output(group):
    r = await call("add_card", group, kind="code", question="How many?", code="print(3)")
    cid = _cid(r)
    assert r.text.splitlines()[0] == '$ add_card kind="code" question="How many?" code="print(3)"'
    assert "L1|3" in r.text and not _mismatch(r, "code")
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["kind"] == "code" and cell["title"] == "How many?" and cell["created_by"] == "chat" and cell["notebook"] == group
    assert cell["status"] == "ok" and cell["labels"] == []
    # a clean card with no takeaway ends its result by asking for one, and the next card starts with the reminder
    assert r.text.rstrip().endswith(tools.hint("takeaway-missing", cid=cid)) and "takeaway pending" not in r.text
    r2 = await call("add_card", group, question="And then?", code="print(4)")
    assert _body(r2).startswith(tools.hint("takeaway-reminder", cid=cid))
    # once the takeaway is written, neither line comes back for that card
    await call("edit_card", group, cell=_cid(r2), takeaway="Four.")
    r3 = await call("edit_card", group, cell=_cid(r2), code="print(5)")
    assert tools.hint("takeaway-missing", cid=_cid(r2)) in r3.text  # a new run clears the stale takeaway, so it is asked for again
    r4 = await call("add_card", group, question="Errors?", code="raise ValueError('x')")
    assert "takeaway-missing" not in r4.text and tools.hint("takeaway-missing", cid=_cid(r4)) not in r4.text
    # `title` is the alias of `question`; an empty question or an unknown kind is refused before anything runs
    assert not (await call("add_card", group, title="Alias?", code="print(5)")).is_error
    assert (await call("add_card", group, code="print(1)")).is_error
    assert (await call("add_card", group, kind="md", question="q", code="1")).is_error
    assert (await call("add_card", group, kind="table", question="q")).is_error


async def test_add_cell_checks_the_output_against_the_kind(group):
    r = await call("add_card", group, kind="table", question="Text?", code="print('rows')")
    cid = _cid(r)
    assert tools.hint("kind-mismatch", cid=cid, kind="table", shape="text") in r.text
    r = await call("add_card", group, kind="table", question="Frame?", code="import pandas as pd\npd.DataFrame({'n': [1, 2]})")
    assert not _mismatch(r, "table") and "rendered a chart/table" in r.text
    r = await call("add_card", group, kind="plot", question="Chart?", code="import pandas as pd\npd.DataFrame({'n': [1]})")
    assert tools.hint("kind-mismatch", cid=_cid(r), kind="plot", shape="table") in r.text
    r = await call("add_card", group, kind="plot", question="Figure?", code="import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.show()")
    assert not _mismatch(r, "plot")
    assert notebook.get_cell(CORPUS, _cid(r))["kind"] == "plot"
    # edit_card with another kind changes the card's kind in place and checks the output against the new one
    r = await call("edit_card", group, cell=cid, kind="plot")
    assert _cid(r) == cid and tools.hint("kind-mismatch", cid=cid, kind="plot", shape="text") in r.text
    assert notebook.get_cell(CORPUS, cid)["kind"] == "plot"
    # an errored card gets the errored hint, which names edit_card, and not the kind check
    r = await call("add_card", group, kind="table", question="Broken?", code="1/0")
    assert "ZeroDivisionError" in r.text and tools.hint("card-errored") in r.text and not _mismatch(r, "table")
    assert "`edit_card`" in tools.hint("card-errored") and "replace" not in tools.hint("card-errored")


async def test_add_card_data_kinds_store_a_payload_and_do_not_run(group):
    r = await call("add_card", group, kind="note", question="An open question", text="Why [[events.jsonl#L1]]?")
    cid = _cid(r)
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["kind"] == "note" and cell["payload"] == {"text": "Why [[events.jsonl#L1]]?"} and "status" not in cell
    assert cell["title"] == "An open question" and cell["created_by"] == "chat"
    r = await call("add_card", group, kind="example", question="One record", refs=["[[events.jsonl#L1]]", "board.jsonl#L2"])
    assert notebook.get_cell(CORPUS, _cid(r))["payload"] == {"refs": ["events.jsonl#L1", "board.jsonl#L2"]}
    r = await call("add_card", group, kind="custom", question="A widget", html="<b>hi</b>")
    assert notebook.get_cell(CORPUS, _cid(r))["payload"] == {"html": "<b>hi</b>"}
    # a diagram or a timeline is drawn from what its code hands thimble.diagram or thimble.timeline: add_card takes no
    # `dataset`, and one sent anyway draws nothing
    assert "dataset" not in tools.schema_of("add_card")["properties"]
    for kind, end in (("timeline", "thimble.timeline(events)"), ("diagram", "thimble.diagram(nodes, edges)")):
        r = await call("add_card", group, kind=kind, question="When?", dataset={"events": [{"t": 1}]})
        assert r.is_error and _body(r) == f"add_card: a {kind} card needs `code` that ends in {end}, after import thimble", r.text
    # add_card only adds: `replace` is ignored; a `takeaway` is the new card's
    r = await call("add_card", group, kind="note", question="q", text="t", takeaway="The point.", replace=cid)
    assert _cid(r) != cid and notebook.get_cell(CORPUS, _cid(r)).get("takeaway") == "The point."
    assert notebook.get_cell(CORPUS, cid)["payload"] == {"text": "Why [[events.jsonl#L1]]?"}
    assert not {"replace", "takeaway_for"} & set(tools.schema_of("add_card")["properties"])
    assert "label" not in tools.schema_of("add_card")["properties"]["kind"]["enum"]
    # what a data card needs
    for kind, extra in (("note", {}), ("example", {"refs": []}), ("custom", {}), ("timeline", {}), ("diagram", {}), ("plot", {})):
        r = await call("add_card", group, kind=kind, question="q", **extra)
        assert r.is_error and "add_card:" in r.text, (kind, r.text)
    r = await call("add_card", group, kind="label", question="q")
    assert r.is_error and "apply_label" in r.text
    assert len(notebook.load_notebook(CORPUS, group)["cells"]) == 4


async def test_a_takeaway_with_a_change_is_checked_against_the_new_output(group):
    """A card's code and its takeaway change in one call: the card runs, then the takeaway's numbers are
    resolved against the new output and a value it does not show is named. Over a run that errored the takeaway is not
    saved, and a note's text and its takeaway change together."""
    cid = _cid(await call("add_card", group, question="How many?", code="print(42)"))
    await call("edit_card", group, card=cid, takeaway="There are 42.")
    r = await call("edit_card", group, card=cid, code="print(43)", takeaway="There are 43, not 42.")
    assert not r.is_error and "L1|43" in r.text and f"takeaway noted on card:{cid}" in r.text
    assert tools.hint("not-found-in-outputs", values="42") in r.text and tools.hint("takeaway-missing", cid=cid) not in r.text
    cell = notebook.get_cell(CORPUS, cid)
    assert cell["code"] == "print(43)" and cell["takeaway"].startswith("There are [[43|card:")
    r = await call("edit_card", group, card=cid, question="How many now?", takeaway="Still 43.")
    assert not r.is_error and notebook.get_cell(CORPUS, cid)["title"] == "How many now?"
    assert notebook.get_cell(CORPUS, cid)["takeaway"].startswith("Still [[43|card:")
    r = await call("edit_card", group, card=cid, code="raise ValueError('no')", takeaway="There are 44.")
    assert tools.hint("edit_card-takeaway-errored") in r.text
    assert "44" not in notebook.get_cell(CORPUS, cid)["takeaway"], "not saved over an error"
    note = _cid(await call("add_card", group, kind="note", question="q", text="t"))
    r = await call("edit_card", group, card=note, text="new text", takeaway="The note says so.")
    assert not r.is_error and notebook.get_cell(CORPUS, note)["payload"] == {"text": "new text"}
    assert notebook.get_cell(CORPUS, note)["takeaway"] == "The note says so."


async def test_add_card_takes_a_takeaway_checked_against_the_new_card(group):
    """A takeaway given to add_card is stored once the card is in: on a card of code resolved against its first run's
    output, a value it does not show named; on an example as written; not over a run that errored."""
    r = await call("add_card", group, question="How many?", code="print(42)", takeaway="There are 42, not 7.")
    cid = _cid(r)
    assert f"takeaway noted on card:{cid}" in r.text and tools.hint("not-found-in-outputs", values="7") in r.text
    assert tools.hint("takeaway-missing", cid=cid) not in r.text
    assert notebook.get_cell(CORPUS, cid)["takeaway"].startswith("There are [[42|card:")
    r = await call("add_card", group, kind="example", question="One post?", refs=["board.jsonl#L1"], takeaway="A protocol.")
    ex = _cid(r)
    assert notebook.get_cell(CORPUS, ex)["takeaway"] == "A protocol."
    # an example's takeaway that cites none of its records is stored, and the result asks for the records' links
    assert tools.hint("takeaway-uncited-example", ref="board.jsonl#L1") in r.text
    # a quote cited through the example and the file it quotes is stored as that quote's ref
    r = await call("edit_card", group, card=f"card:{ex}", takeaway=f"A [[protocol|card:{ex}#board.jsonl]].")
    assert not r.is_error, r.text
    assert tools.hint("takeaway-uncited-example", ref="board.jsonl#L1") not in r.text
    assert notebook.get_cell(CORPUS, ex)["takeaway"] == "A [[protocol|board.jsonl#L1]]."
    r = await call("add_card", group, question="Broken?", code="raise ValueError('no')", takeaway="Fine.")
    assert tools.hint("edit_card-takeaway-errored") in r.text and not notebook.get_cell(CORPUS, _cid(r)).get("takeaway")


ALTAIR_BAR = """import altair as alt, pandas as pd
df = pd.DataFrame({"sender": ["agent-3", "agent-7", "agent-1"], "messages": [412, 201, 97]})
alt.Chart(df).mark_bar().encode(x="sender", y="messages")"""


async def test_a_charts_rows_reach_the_model_in_its_result_and_its_values_cite_by_column_and_row(group):
    r = await call("add_card", group, kind="plot", question="Who wrote the most?", code=ALTAIR_BAR)
    cid = _cid(r)
    head = tools.hint("chart-rows", out=0, rows=3, cid=cid, label="sender")
    assert head and head in r.text and not _mismatch(r, "plot")
    after = r.text.split(head, 1)[1].splitlines()
    assert after[0] == "" and after[1].split() == ["sender", "messages"], "the label column first, as a frame's index"
    assert [ln.split() for ln in after[2:5]] == [["agent-3", "412"], ["agent-7", "201"], ["agent-1", "97"]]
    # the card itself holds only the chart: no table output was added under it
    cell = notebook.get_cell(CORPUS, cid)
    assert [k for b in cell["outputs"] for k in b if k == "text/html"] == []
    # read_ref shows the same rows, and a value in them is a td span that resolves and verifies
    rr = await call("read_ref", group, ref=f"card:{cid}#messages/agent-3")
    assert head in rr.text and f"span card:{cid}#messages/agent-3: 412" in rr.text
    r = await call("edit_card", group, takeaway=f"agent-3 wrote [[412|card:{cid}#messages/agent-3]], twice agent-7's 201.")
    assert not r.is_error and "linked" in r.text
    stored = notebook.get_cell(CORPUS, cid)["takeaway"]
    assert f"[[412|card:{cid}#messages/agent-3]]" in stored and f"[[201|card:{cid}#messages/agent-7]]" in stored
    # edit_card's re-run carries the rows of the new chart
    r = await call("edit_card", group, cell=cid, code=ALTAIR_BAR.replace("412", "413"))
    assert tools.hint("chart-rows", out=0, rows=3, cid=cid, label="sender") in r.text and "413" in r.text


async def test_edit_card_changes_a_data_cards_content_and_question_in_place(group):
    """A note's text and question change in place, not by a second card; `code` on a note is refused, naming the field
    that changes it."""
    note = _cid(await call("add_card", group, kind="note", question="Old?", text="old"))
    r = await call("edit_card", group, card=f"card:{note}", question="New?", text="new")
    assert not r.is_error, r.text
    cell = notebook.get_cell(CORPUS, note)
    assert (cell["title"], cell["payload"]) == ("New?", {"text": "new"}) and cell["edited"], "the change is recorded"
    r = await call("edit_card", group, card=note, code="print(1)")
    assert r.is_error and _body(r) == tools.hint("edit_card-data", cid=note, kind="note", field="text") and "`text`" in r.text
    r = await call("edit_card", group, card=note, kind="table")
    assert r.is_error and _body(r) == tools.hint("edit_card-kind", cid=note, kind="note", new="table")
    assert len(notebook.load_notebook(CORPUS, group)["cells"]) == 1, "edited in place, not duplicated"


async def test_an_example_ref_with_a_quote_shows_that_passage(group):
    """An example ref given as {ref, quote} is stored as the span of the quoted passage in that record, so the card shows
    the passage rather than the record's first lines; the quote matches loosely (case and runs of spaces), and a quote
    the record does not hold is refused with the ref it was looked for in."""
    quote = "review someone else's pending request in return"
    r = await call("add_card", group, kind="example", question="What do reviews ask?", refs=[{"ref": "board.jsonl#L1", "quote": quote}])
    cid = _cid(r)
    stored = notebook.get_cell(CORPUS, cid)["payload"]["refs"]
    assert len(stored) == 1 and re.fullmatch(r"board\.jsonl#L1\.b0:c\d+-\d+", stored[0]), stored
    assert refs.resolve(config.corpus_dir(CORPUS), stored[0])["excerpt"] == quote
    loose = _cid(await call("add_card", group, kind="example", question="Folded?",
                            refs=["board.jsonl#L3", {"ref": "board.jsonl#L1-L3", "quote": "PLEASE use   thread 1"}]))
    stored = notebook.get_cell(CORPUS, loose)["payload"]["refs"]
    assert stored[0] == "board.jsonl#L3" and stored[1].startswith("board.jsonl#L3.b0:")
    assert refs.resolve(config.corpus_dir(CORPUS), stored[1])["excerpt"] == "please use thread 1"
    r = await call("add_card", group, kind="example", question="Missing?", refs=[{"ref": "board.jsonl#L1", "quote": "not in it"}])
    assert r.is_error and tools.hint("example-quote-missing", ref="board.jsonl#L1", quote="not in it") in r.text


async def test_list_cells_takes_a_group_by_the_path_add_cell_takes(group):
    """add_card makes `Orientation / Final` as Final under Orientation, and list_cards takes the same name and prints
    it."""
    cid = _cid(await call("add_card", group, kind="note", question="Map?", text="t", group="Orientation / Final"))
    r = await call("list_cards", group, group="Orientation / Final")
    assert not r.is_error, r.text
    assert _body(r).splitlines()[0].startswith('Group "Orientation / Final"') and f"- card:{cid} [note] Map?" in r.text
    r = await call("list_cards", group, group="orientation / final")
    assert not r.is_error and f"card:{cid}" in r.text
    r = await call("list_cards", group, group="Orientation / Nowhere")
    assert r.is_error and "'Orientation / Final'" in r.text and "'Your work'" in r.text


async def test_the_terminals_named_groups_are_all_children_of_its_root(group):
    """Each group the terminal session opens by name hangs under its root notebook, not inside the group it opened last.
    The terminal analyst has no explicit notebook, so its group's parent is resolved through analyst_notebook."""
    root = tools.terminal_notebook(CORPUS)
    for name in ["Corpus size", "Who claims what", "How reviews are asked for", "Stalled pull requests"]:
        r = await tools.call(CORPUS, "add_card", {"kind": "note", "question": "q", "text": "t", "group": name},
                             actor="analyst", notebook=None, terminal=True)
        assert not r.is_error, r.text
    ws = config.workspace_dir(CORPUS)
    names = {"Corpus size", "Who claims what", "How reviews are asked for", "Stalled pull requests"}
    made = [g for g in notebook.list_notebooks(ws) if g.get("title") in names]
    assert len(made) == 4 and {g["parent"] for g in made} == {root}, [(g["title"], g["parent"]) for g in made]


async def test_delete_cell_removes_a_card_and_says_which(group):
    """A second copy of a card goes; the first stays. A card already gone, or none named, is an error that says so."""
    keep = _cid(await call("add_card", group, kind="note", question="Who posted most?", text="t"))
    dup = _cid(await call("add_card", group, kind="note", question="Who posted most?", text="t"))
    r = await call("delete_card", group, cell=f"card:{dup}")
    assert not r.is_error and _body(r) == tools.hint("delete_card-deleted", cid=dup, question="Who posted most?"), r.text
    assert notebook.get_cell(CORPUS, dup) is None and notebook.get_cell(CORPUS, keep) is not None
    assert [c["id"] for c in notebook.load_notebook(CORPUS, group)["cells"]] == [keep]
    r = await call("delete_card", group, cell=dup)
    assert r.is_error and _body(r) == tools.hint("edit_card-gone", cid=dup)
    r = await call("delete_card", group)
    assert r.is_error and _body(r) == tools.hint("edit_card-no-card")
    assert tools.schema_of("delete_card")["required"] == ["card"]


async def test_delete_cell_keeps_a_card_a_document_cites(group):
    """Deleting a card the report cites, or pins as a figure, would leave the report pointing at nothing, so the card is
    kept and the result names the document; a card whose id only starts the cited one's is not held."""
    cited = _cid(await call("add_card", group, kind="note", question="The spike", text="t"))
    other = _cid(await call("add_card", group, kind="note", question="Another", text="t"))
    inv = config.workspace_dir(CORPUS) / "investigations" / "main"
    inv.mkdir(parents=True, exist_ok=True)
    (inv / "investigation.json").write_text(json.dumps({"id": "main", "note": f"card:{other}"}))
    (inv / "report.json").write_text(json.dumps({"sections": [{"text": f"It rose [[40|card:{cited}#n/total]]."}]}))
    (inv / "report.frame.json").write_text(json.dumps({"figures": [{"cell": f"card:{cited}"}]}))
    (inv / "story.json").write_text(json.dumps({"figures": [{"cell": f"card:{cited}x"}]}))
    r = await call("delete_card", group, cell=cited)
    assert r.is_error and _body(r) == tools.hint("delete_card-cited", cid=cited, docs="report:report"), r.text
    assert notebook.get_cell(CORPUS, cited) is not None
    r = await call("delete_card", group, cell=other)
    assert not r.is_error and notebook.get_cell(CORPUS, other) is None


async def test_a_field_the_card_s_kind_does_not_show_is_refused_not_dropped(group):
    """add_card's kinds each show one field: `code` given to an example card, or a note's `text` given with no kind
    (the default kind is code), is refused with the kind that field belongs to, and edit_card refuses a note's `text` on
    a card of code instead of running the code again as it was. A refused edit_card leaves the card in its group."""
    r = await call("add_card", group, kind="example", question="One event?", refs=["events.jsonl#L1"], code="print(1)")
    assert r.is_error and "runs no `code`" in r.text
    r = await call("add_card", group, question="What is left?", text="- the tables")
    assert r.is_error and "`text` is what a note card shows, so pass kind note" in r.text
    # a note's text or an example's refs beside the code of a card that runs is refused before it runs, not dropped
    before = len(notebook.read_notebook(config.workspace_dir(CORPUS), group)["cells"])
    r = await call("add_card", group, kind="table", question="How many rows?", code="print(3)", text="From the sample.")
    assert r.is_error and _body(r) == ("add_card: a table card shows what its `code` outputs, and `text` is what a note "
                                       "card shows, so leave `text` out, or add a note card for it"), r.text
    r = await call("add_card", group, question="How many rows?", code="print(3)", refs=["events.jsonl#L1"])
    assert r.is_error and "`refs` is what an example card shows" in r.text
    assert len(notebook.read_notebook(config.workspace_dir(CORPUS), group)["cells"]) == before, "no card was added"
    cid = _cid(await call("add_card", group, kind="code", question="How many?", code="print(3)"))
    ran = notebook.get_cell(CORPUS, cid)["exec_count"]
    r = await call("edit_card", group, card=cid, text="three", group="Elsewhere")
    assert r.is_error and _body(r) == tools.hint("edit_card-kind", cid=cid, kind="code", new="note")
    after = notebook.get_cell(CORPUS, cid)
    assert after["exec_count"] == ran and after["notebook"] == group, "not run, not moved"


