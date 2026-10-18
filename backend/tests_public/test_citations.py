"""Citations (app/cite.py, verify.py): a number in a takeaway is linked only where its value has exactly one home in the
card's outputs, a value cited at the row its words name stays there, and a date in words and a clock time are each one
value. The tables here are invented.

The links check on cards written to disk with handmade outputs, no kernel and no model. A citation of a number the
card's code types in rather than computes (cite.typed_citations): a diagram card's takeaway cited
14,591 at a node label the code typed as "revisions.jsonl: 14,591 saves", and the links check passed, while the same
card printed len(R) = 14591 on another line.

The false × of 10-16: a takeaway cited a correct 6 at a line that printed "2026, 6, 2026", and the links check marked it
contradicted. A value that is one of several values the cited place shows passes; a 6 at a place that shows only a
longer number such as "1,206" still fails."""
from __future__ import annotations

from app import cite, config, notebook, verify

CORPUS = "mini"
LOAD = 'import json\nimport thimble\nR = [json.loads(line) for line in open("revisions.jsonl")]\n'
PRINT = 'print("len(R) =", len(R))\n'
TYPED = 'thimble.diagram(edges=[("revisions.jsonl: 14,591 saves", "pages.jsonl: 312 pages", "edits")])\n'
EDGE = [("revisions.jsonl: 14,591 saves", "pages.jsonl: 312 pages", "edits")]
PRINTED = {"_stream": "stdout", "text/plain": "len(R) = 14591\n"}


def drawn(edges: list) -> dict:
    """The bundle thimble.diagram shows for `edges` (kernel_thimble.diagram, its display caught)."""
    from app import kernel_thimble

    shown: list[dict] = []
    real = kernel_thimble._show
    kernel_thimble._show = shown.append
    try:
        kernel_thimble.diagram(edges=edges)
    finally:
        kernel_thimble._show = real
    return shown[0]


def card(code: str, outputs: list[dict], takeaway: str, kind: str = "code") -> dict:
    """A card that ran `code` clean and showed `outputs`, with `takeaway` stored as add_card stores one (its `SELF` the
    card's id), the verification hook run: the card as the notebook holds it."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Exploration", role="exploration")
    cell = notebook.new_cell(kind, "run", "How many saves does revisions.jsonl hold?", nb["id"], code=code)
    cell.update(status="ok", exec_count=1, outputs=outputs)
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    assert notebook.append_takeaway(CORPUS, cell["id"], takeaway.replace("SELF", cell["id"]), overwrite=True,
                                    author="model")
    return notebook.get_cell(CORPUS, cell["id"])


async def checked(cell: dict) -> dict:
    """The card's `links` after the links check ran on it (verify._links_job), as the server runs it."""
    cid = cell["id"]
    await verify._links_job(CORPUS, cid, verify._links_version(notebook.get_cell(CORPUS, cid)))
    return notebook.get_cell(CORPUS, cid)["verification"]["links"]


def _values(entries: list[dict]) -> list[str]:
    return [str(e.get("value")) for e in entries]


def test_a_citation_of_a_typed_label_moves_to_the_value_the_card_printed(workspaces_tmp):
    """The diagram card: the takeaway cites 14,591 at the diagram's label, typed in the code, and the card printed len(R) on
    its first output. The citation moves there, and is linked, with the typed place kept as where it was cited."""
    cell = card(LOAD + PRINT + TYPED, [PRINTED, drawn(EDGE)],
                "revisions.jsonl holds [[14,591|card:SELF@out1#L2]] saves.", kind="diagram")
    cid = cell["id"]
    assert cell["takeaway"] == f"revisions.jsonl holds [[14,591|card:{cid}@out0#L1]] saves."
    links = cell["verification"]["links"]
    assert links["typed"] == [] and links["status"] == "ok"
    assert links["resolved"] == [{"value": "14,591", "ref": f"card:{cid}@out0#L1", "tier": 2, "how": cite.COMPUTED,
                                  "from": f"card:{cid}@out1#L2"}]


def test_a_citation_of_a_typed_label_with_no_computed_place_is_typed_with_its_line(workspaces_tmp):
    """The same card without the print: nothing on it computes 14,591, so the citation stays where it is and is typed,
    with the line of the code that types it, and the links check counts it as a problem."""
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds [[14,591|card:SELF@out0#L2]] saves.",
                kind="diagram")
    cid = cell["id"]
    assert cell["takeaway"] == f"revisions.jsonl holds [[14,591|card:{cid}@out0#L2]] saves."
    links = cell["verification"]["links"]
    assert links["typed"] == [{"value": "14,591", "ref": f"card:{cid}@out0#L2", "line": 4,
                               "why": "typed in the code, line 4, not computed"}]
    assert links["resolved"] == [] and links["status"] == "unresolved"
    # a number the takeaway leaves plain, linked to the one place that shows it, is typed the same way
    cell = card(LOAD + TYPED, [drawn(EDGE)], "revisions.jsonl holds 14,591 saves.", kind="diagram")
    assert [t["ref"] for t in cell["verification"]["links"]["typed"]] == [f"card:{cell['id']}@out0#L2"]


async def test_a_value_among_several_a_printed_tuple_shows_is_linked_not_contradicted(workspaces_tmp):
    cell = card('print((2026, 6, 2026))\n', [{"_stream": "stdout", "text/plain": "(2026, 6, 2026)\n"}],
                "The run printed month [[6|card:SELF@out0#L1]].")
    links = await checked(cell)
    assert "6" in _values(links["resolved"]), links
    assert not links.get("broken"), links


async def test_a_6_cited_at_a_line_that_shows_only_a_longer_number_stays_contradicted(workspaces_tmp):
    cell = card("print('1,206')\n", [{"_stream": "stdout", "text/plain": "1,206\n"}],
                "The run printed [[6|card:SELF@out0#L1]].")
    links = await checked(cell)
    assert _values(links.get("broken") or []) == ["6"], links
    assert "6" not in _values(links["resolved"]), links


def test_a_tables_check_left_pending_runs_again_when_the_server_starts(workspaces_tmp, monkeypatch):
    """The ◌ for good of 10-17: a table's or a plot's links check that a stopped server or an ended `thimble-run` left
    pending is queued again by the rescan at the server's start, as a `code` card's is; the rescan skipped every other
    kind, so starting the server again left its citations ◌."""
    cell = card(LOAD + PRINT, [PRINTED], "revisions.jsonl holds [[14,591|card:SELF@out0#L1]] saves.", kind="table")
    ws = config.workspace_dir(CORPUS)
    with notebook.editing(ws):
        nb, stored = notebook._locate(ws, cell["id"])
        stored["verification"]["links"].update(status="pending", checked=False)
        notebook.write_notebook(ws, nb)
    queued: list[str] = []
    monkeypatch.setattr(verify, "CHECK_JOBS", True)
    monkeypatch.setattr(verify, "_enqueue_links", lambda c, cell, version: bool(queued.append(cell["id"])) or True)
    assert verify.rescan(CORPUS) == 1
    assert queued == [cell["id"]]


async def test_a_card_checks_fix_that_runs_at_the_same_count_checks_its_takeaway_again(workspaces_tmp, monkeypatch):
    """The ◌ for good of the bug hunt (10-17, B8): a card check's fix lands its run (notebook.land_run) with the card's
    exec_count as it was, and the takeaway as it was, so the links job it queued had the key of the job that had run
    already; the queue answers such a key with no job, and the takeaway stayed `pending` while the thimble line showed
    `◌`. Each pass of the links is a job of its own."""
    done: set[str] = set()
    queued: list[str] = []

    def enqueue(c: str, cell: dict, version: str) -> bool:  # the queue's rule: a key queued or done is no new job
        if version in done:
            return False
        done.add(version)
        queued.append(version)
        return True

    monkeypatch.setattr(verify, "CHECK_JOBS", True)
    monkeypatch.setattr(verify, "_enqueue_links", enqueue)

    async def run_queued(cid: str) -> dict:
        while queued:
            await verify._links_job(CORPUS, cid, queued.pop(0))
        return notebook.get_cell(CORPUS, cid)["verification"]["links"]

    cell = card(LOAD + PRINT, [PRINTED], "revisions.jsonl holds [[14,591|card:SELF@out0#L1]] saves.")
    cid = cell["id"]
    assert (await run_queued(cid))["status"] == "ok"
    ws = config.workspace_dir(CORPUS)
    with notebook.editing(ws):
        nb, stored = notebook._locate(ws, cid)
        notebook.land_run(CORPUS, nb, stored, LOAD + "\n" + PRINT, [PRINTED], "ok", by="check")
        notebook.write_notebook(ws, nb)
    assert notebook.get_cell(CORPUS, cid)["exec_count"] == 1
    assert (await run_queued(cid))["status"] == "ok"


def test_tier2_unique_table_cell():
    html = (
        "<table><thead><tr><th></th><th>assignments</th></tr></thead>"
        "<tbody><tr><th>north-desk</th><td>250</td></tr>"
        "<tr><th>south-desk</th><td>30</td></tr></tbody></table>"
    )
    r = cite.resolve("c1", "North 250, South 30.", [{"text/html": html, "text/plain": "..."}])
    assert "[[250|card:c1#assignments/north-desk]]" in r.annotated
    assert "[[30|" not in r.annotated  # a 2-digit integer is too ambiguous to auto-link on uniqueness alone
    assert r.unresolved == ["30"]


def test_a_takeaways_value_at_the_row_its_words_name_stays_there():
    """Live check term-fix7, new quirk 1, in a takeaway: a value cited at the row its words name, which shows another
    value, stays at that row (named in `misplaced`), never moved to the one row that shows it."""
    from app import frames

    f = frames.normalize({"columns": ["hour", "deletions"], "rows": [["22:00", 40], ["23:00", 89]], "index": "hour"})
    out = [frames.bundle(f)]
    r = cite.resolve("c1", "A last [[89|card:c1#deletions/22:00]] in the 22:00 hour.", out)
    assert r.annotated == "A last [[89|card:c1#deletions/22:00]] in the 22:00 hour."
    assert [(l.token, l.ref) for l in r.misplaced] == [("89", "card:c1#deletions/22:00")]
    r = cite.resolve("c1", "A last [[89|card:c1#deletions/22:00]] deletions.", out)
    assert r.annotated == "A last [[89|card:c1#deletions/23:00]] deletions." and not r.misplaced


def test_an_uncited_date_in_words_is_linked_whole_or_left_plain():
    """Live check term-fix8, quirk 4: main wrote plain "On 23 June", and the check linked its `23` alone, with `June` as
    its unit, to the agent's answer at 23:41 ("On 23 ✓ June"). A day and a month in words is one value: linked whole to
    the one line or cell that writes that date in digits, else left plain; its day and its year are never numbers."""
    from app import frames

    out = [{"_stream": "stdout", "text/plain": "2026-06-22 deletes 40\n23 runs at 23:41 answered\n2026-06-24 deletes 7\n"}]
    r = cite.resolve("c1", "On 23 June there were 40 deletes.", out)
    assert r.annotated == "On 23 June there were 40 deletes." and "23 June" in r.unresolved and "23" not in r.unresolved
    assert all("23" != link.token for link in r.links)
    r = cite.resolve("c1", "By 24 June 2026 the deletes fell.", out)
    assert r.annotated == "By [[24 June 2026|card:c1@out0#L3]] the deletes fell." and r.unresolved == []
    r = cite.resolve("c1", "From June 22 on, and 4 June 2026 at 10:53 UTC.", out)
    assert "[[June 22|card:c1@out0#L1]]" in r.annotated and "[[4|" not in r.annotated and "[[10|" not in r.annotated
    # two places write the date: left plain, as an ambiguous number is, and not called missing
    twice = [{"text/plain": "2026-06-23 20:00 deletes\n2026-06-23 23:41 answer\n"}]
    r = cite.resolve("c1", "On 23 June they deleted.", twice)
    assert r.annotated == "On 23 June they deleted." and r.unresolved == [] and not r.links
    # a table's cell that writes the date
    f = frames.normalize({"columns": ["day", "n"], "rows": [["06-23", 602], ["07-07", 522]], "index": "day"})
    r = cite.resolve("c2", "The busiest was 23 June.", [frames.bundle(f)])
    assert r.annotated == "The busiest was [[23 June|card:c2#day/06-23]]."
    # `may` in lower case is the verb
    assert [d[2] for d in cite.dates_in_text("3 may fail; May 3rd; 10 marches")] == ["May 3rd"]


def test_a_clock_time_is_a_value_found_where_its_place_writes_that_time():
    """A time such as `14:52:11` showed no value, so the terminal said "its value is not checked, and a script got the
    same number" and a wrong time at its place was never red. A clock time alone is a value: it is at a place that writes
    the same hour and minute (and second, when it gives one), never inside another time."""
    from app import report, verify

    line = '{"id": 197, "ts": "2026-08-30T14:52:11.325+00:00", "agent": "agent-07", "action": "git.ref"}'
    for display in ["14:52", "14:52:11", "14:52:11.325", "09:38 UTC"]:
        assert cite.is_clock(display) and cite.shows_value(display), display
    assert not cite.is_clock("14:52 and 14:58") and not cite.is_clock("at 14:52")
    for display in ["14:52", "14:52:11", "14:52:11.325"]:
        assert cite.value_in(display, line) and verify._value_matches(display, line) and report._value_matches(display, line), display
    for display in ["14:58", "14:52:12", "4:52"]:
        assert not cite.value_in(display, line), display
    assert cite.value_in("09:38", "at 9:38:00 the run began")
