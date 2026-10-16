"""The false × of 10-16: a card's takeaway cited a correct 6 at a place whose output printed "2026, 6, 2026", and the
card links check marked it contradicted ("the cited place shows 2026, 6, 2026"). The check is run here as the server
runs it (verify._links_job on a card written to disk with handmade outputs, no kernel and no model), for a printed
tuple cited by its output line and for a table cell holding the same text cited by its column and row. Two steps
refused a correct citation: a td span whose cell writes several values (cite._Sources.verify read the cell as one
value, so the 6 was unwrapped as "was 6 in an earlier run"), and a display of several numbers ("6 of 2026") at a line
that prints them all (value_in reads one number, so the place "showed" 2026, 6, 2026 and the token was red). A value
that is one of several values the cited place shows passes now; a 6 at a place that shows only "1,206" or "2026"
still fails. cite.value_in already took the single-number cases on 0.8.0; they stay here as regression tests."""
from __future__ import annotations

import pytest

from app import cite, config, notebook, verify

CORPUS = "mini"
AUTHOR = "model"  # who wrote the takeaways (heal treats the analyst's own words apart)
PRINT_TUPLE = 'print((2026, 6, 2026))\n'
TUPLE_OUT = {"_stream": "stdout", "text/plain": "(2026, 6, 2026)\n"}
TABLE_HTML = ("<table><thead><tr><th></th><th>when</th><th>count</th></tr></thead>"
              "<tbody><tr><th>first</th><td>2026, 6, 2026</td><td>1,206</td></tr>"
              "<tr><th>second</th><td>2026</td><td>17</td></tr></tbody></table>")
TABLE_OUT = {"text/html": TABLE_HTML, "text/plain": "        when  count\nfirst   2026, 6, 2026  1,206\nsecond  2026  17\n"}


def card(code: str, outputs: list[dict], takeaway: str, kind: str = "code") -> dict:
    """A card that ran `code` clean and showed `outputs`, with `takeaway` stored as add_card stores one (`SELF` its id),
    the verification hook run."""
    ws = config.workspace_dir(CORPUS)
    nb = notebook.create_notebook(ws, "Exploration", role="exploration")
    cell = notebook.new_cell(kind, "run", "What does the run print?", nb["id"], code=code)
    cell.update(status="ok", exec_count=1, outputs=outputs)
    nb["cells"].append(cell)
    notebook.write_notebook(ws, nb)
    assert notebook.append_takeaway(CORPUS, cell["id"], takeaway.replace("SELF", cell["id"]), overwrite=True,
                                    author=AUTHOR)
    return notebook.get_cell(CORPUS, cell["id"])


async def checked(cell: dict) -> dict:
    """The card's `links` after the links check ran on it (verify._links_job), as the server runs it."""
    cid = cell["id"]
    await verify._links_job(CORPUS, cid, verify._links_version(notebook.get_cell(CORPUS, cid)))
    return notebook.get_cell(CORPUS, cid)["verification"]["links"]


def _values(entries: list[dict]) -> list[str]:
    return [str(e.get("value")) for e in entries]


@pytest.mark.parametrize("ref", ["card:SELF@out0#L1", "card:SELF@out0"])
async def test_a_value_among_several_a_printed_tuple_shows_is_linked_not_contradicted(workspaces_tmp, ref):
    cell = card(PRINT_TUPLE, [TUPLE_OUT], f"The run printed month [[6|{ref}]].")
    links = await checked(cell)
    assert "6" in _values(links["resolved"]), links
    assert not links.get("broken"), links
    assert all("2026, 6, 2026" not in str(e.get("source")) for e in links.get("broken") or [])


async def test_a_value_among_several_in_a_table_cell_is_linked_not_contradicted(workspaces_tmp):
    cell = card("df", [TABLE_OUT], "The first run fell in month [[6|card:SELF#when/first]].", kind="table")
    links = await checked(cell)
    assert "6" in _values(links["resolved"]), links
    assert not links.get("broken"), links


@pytest.mark.parametrize("ref", ["card:SELF@out0#L1", "card:SELF@out0"])
async def test_a_display_of_several_numbers_the_printed_tuple_shows_is_linked(workspaces_tmp, ref):
    """The captured tip ("the cited place shows 2026, 6, 2026"): a display that writes 6 and 2026 at the line that
    prints both was contradicted, since value_in reads one number."""
    cell = card(PRINT_TUPLE, [TUPLE_OUT], f"The run fell in month [[6 of 2026|{ref}]].")
    links = await checked(cell)
    assert "6 of 2026" in _values(links["resolved"]), links
    assert not links.get("broken"), links


async def test_a_display_of_several_numbers_the_table_cell_shows_is_linked(workspaces_tmp):
    cell = card("df", [TABLE_OUT], "The first run fell in month [[6 of 2026|card:SELF#when/first]].", kind="table")
    links = await checked(cell)
    assert "6 of 2026" in _values(links["resolved"]), links
    assert not links.get("broken"), links


async def test_a_display_with_a_number_the_line_does_not_show_stays_contradicted(workspaces_tmp):
    cell = card(PRINT_TUPLE, [TUPLE_OUT], "The run fell in month [[6 of 2025|card:SELF@out0#L1]].")
    links = await checked(cell)
    assert _values(links.get("broken") or []) == ["6 of 2025"], links
    assert links["broken"][0]["why"] == "the cited place shows 2026, 6, 2026"


NEAR_HTML = ("<table><thead><tr><th></th><th>count</th></tr></thead>"
             "<tbody><tr><th>first</th><td>1,206</td></tr><tr><th>second</th><td>2026</td></tr></tbody></table>")
NEAR_OUT = {"text/html": NEAR_HTML, "text/plain": "        count\nfirst   1,206\nsecond  2026\n"}


@pytest.mark.parametrize("shown", ["1,206", "2026"])
async def test_a_6_cited_at_a_line_that_shows_only_a_longer_number_stays_contradicted(workspaces_tmp, shown):
    printed = {"_stream": "stdout", "text/plain": f"{shown}\n"}
    cell = card(f"print({shown!r})\n", [printed], "The run printed [[6|card:SELF@out0#L1]].")
    links = await checked(cell)
    assert _values(links.get("broken") or []) == ["6"], links
    assert "6" not in _values(links["resolved"]), links


@pytest.mark.parametrize("row", ["first", "second"])
async def test_a_6_cited_at_a_cell_that_shows_only_a_longer_number_stays_contradicted(workspaces_tmp, row):
    cell = card("df", [NEAR_OUT], f"The count is [[6|card:SELF#count/{row}]].", kind="table")
    links = await checked(cell)
    assert _values(links.get("broken") or []) == ["6"], links
    assert "6" not in _values(links["resolved"]), links


@pytest.mark.parametrize("excerpt", ["2026, 6, 2026", "(2026, 6, 2026)", "2026,6,2026", "[2026, 6]"])
def test_value_in_finds_a_value_among_several(excerpt):
    assert cite.value_in("6", excerpt)


@pytest.mark.parametrize("excerpt", ["2026", "1,206"])
def test_value_in_does_not_take_a_number_that_only_contains_the_value(excerpt):
    assert not cite.value_in("6", excerpt)
