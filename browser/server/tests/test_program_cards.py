"""A card drawn by a program, as the terminal plugin draws its cards (kind `program`): its code ends in its data, the
program draws the data on the plugin's toolkit in the sandbox, the drawing is kept with the run, the tool result names
the parts Claude can cite, a part is cited as `card:<id>#<part id>`, and a program that fails says what to fix."""
import asyncio

import pytest
from browser_client import Signed

from thimble_browser import canvas, home, tools
from thimble_browser.cards import sandbox
from thimble_browser.features import cards

works = pytest.mark.skipif(sandbox.available() is None, reason="no sandbox on this machine")

CODE = """import pandas as pd
df = pd.read_csv("results.csv")
{"outcomes": [{"outcome": o, "n": len(g), "refs": [f"results.csv#row={i + 1}" for i in g.index]}
              for o, g in df.groupby("outcome")]}"""
PROGRAM = ("return k.bars(data.outcomes.map(d => ({ id: d.outcome, label: d.outcome, value: d.n, "
           "meta: { refs: d.refs } })))")


def add(ws, folder, **args):
    t = tools.Tools(ws, "main", folder)
    return asyncio.run(cards.add_card(t, {"question": "How did the runs end?", **args}))


@works
def test_a_program_card_draws_its_data_and_names_its_parts(folder):
    ws = home.open_folder(folder)
    got = add(ws, folder, code=CODE, program=PROGRAM, takeaway="One of the two runs merged.")
    assert not got.is_error, got.text
    assert "2 parts (cite one as card:<id>#<part id>)" in got.text and "merged" in got.text
    cell = canvas.find(ws, got.cell_id)[1]
    assert cell["kind"] == "program" and cell["status"] == "ok"
    kit = cell["outputs"][-1][canvas.KIT_MIME]
    assert [r["id"] for r in kit["drawing"]["regions"]] == ["failed", "merged"]
    assert kit["data"]["outcomes"][1] == {"outcome": "merged", "n": 1, "refs": ["results.csv#row=1"]}


@works
def test_a_part_is_cited_by_its_id_and_keeps_its_place_after_an_edit(folder):
    api = Signed(folder)
    got = add(api.ws, folder, code=CODE, program=PROGRAM)
    ref = f"card:{got.cell_id}#merged"
    r = api("GET", "/corpora/{ws}/ref", params={"ref": ref}).json()
    assert r["kind"] == "value" and r["meta"]["region"] == "merged" and r["meta"]["part"]["refs"] == ["results.csv#row=1"]
    # the program changes and draws other ids: the citation reads the card as it stood before
    t = tools.Tools(api.ws, "main", folder)
    asyncio.run(cards.edit_card(t, {"card": got.cell_id, "program": PROGRAM.replace("id: d.outcome", "id: 'o-' + d.outcome")}))
    r = api("GET", "/corpora/{ws}/ref", params={"ref": ref}).json()
    assert r["meta"]["region"] == "merged" and r["meta"]["version"]["entry"]


@works
def test_a_part_whose_value_changed_is_read_as_the_citation_stated_it(folder):
    api = Signed(folder)
    got = add(api.ws, folder, code=CODE, program=PROGRAM)
    ref = f"card:{got.cell_id}#merged"
    before = api("GET", "/corpora/{ws}/ref", params={"ref": ref}).json()["meta"]["value"]
    t = tools.Tools(api.ws, "main", folder)
    # the card now shows a share where it showed a count, under the same part ids
    asyncio.run(cards.edit_card(t, {"card": got.cell_id, "program": PROGRAM.replace("value: d.n", "value: d.n * 50")}))
    now = api("GET", "/corpora/{ws}/ref", params={"ref": ref}).json()
    assert "50" in now["meta"]["value"] and "version" not in now["meta"]
    cited = api("GET", "/corpora/{ws}/ref", params={"ref": ref, "value": "1"}).json()
    assert cited["meta"]["value"] == before and cited["meta"]["version"]["entry"]


@works
def test_a_program_that_fails_says_what_to_fix(folder):
    ws = home.open_folder(folder)
    got = add(ws, folder, code=CODE, program="return k.bars(data.nothing.map(d => d))")
    assert "the program did not draw" in got.text and "Fix" in got.text
    assert "Fix it with edit_card" in got.text
    assert canvas.find(ws, got.cell_id)[1]["status"] == "error"


@works
def test_code_that_ends_in_no_value_says_so(folder):
    ws = home.open_folder(folder)
    got = add(ws, folder, code="x = 1", program=PROGRAM)
    assert "ends in no value" in got.text


def test_a_program_card_needs_its_program(folder):
    ws = home.open_folder(folder)
    got = add(ws, folder, kind="program", code=CODE)
    assert got.is_error and "needs `program`" in got.text


@works
def test_the_program_reaches_no_network_and_no_file(folder):
    ws = home.open_folder(folder)
    got = add(ws, folder, code="{}", program="return k.text(String(typeof fetch) + ' ' + String(typeof require) + ' ' + String(typeof process))")
    cell = canvas.find(ws, got.cell_id)[1]
    runs = cell["outputs"][-1][canvas.KIT_MIME]["drawing"]["root"]
    assert "undefined undefined undefined" in str(runs)
