"""A card's id is a readable name of its question (notebook.mint_id), such as `card:prs-merged-week`, unique in the
workspace (`-2`, `-3` on a collision); a card stored with an older random id keeps it, and both resolve wherever a
`card:` ref is read. A card's name (its slug, which a chip shows) resolves too, so a chip can be cited as it reads."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import config, notebook, refs

CORPUS = "mini"


@pytest.fixture()
def ws(workspaces_tmp):
    return config.workspace_dir(CORPUS)


@pytest.fixture()
async def client():
    a = FastAPI()
    a.include_router(notebook.router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t") as c:
        yield c


def _add(title: str, kind: str = "note") -> dict:
    cell = notebook.new_cell(kind, "agent", title, notebook.MAIN, payload={"text": "x"} if kind == "note" else None,
                             workspace=CORPUS)
    return notebook.insert_cell(CORPUS, notebook.active_notebook_id(CORPUS), cell)


def _legacy(title: str) -> dict:
    """A card as an older thimble stored it: a random id and no name."""
    cell = notebook.new_cell("note", "agent", title, notebook.MAIN, payload={"text": "x"})
    cell["slug"] = ""
    nb = notebook.load_notebook(CORPUS, notebook.active_notebook_id(CORPUS))
    nb["cells"].append(cell)
    notebook.save_notebook(CORPUS, nb)
    return cell


def test_a_new_card_is_named_by_its_question_and_a_second_one_takes_a_number(ws):
    one = _add("How many PRs merged per week?")
    two = _add("How many PRs merged per week")
    assert one["id"] == one["slug"] == "prs-merged-week"
    assert two["id"] == two["slug"] == "prs-merged-week-2"
    assert _add("")["id"] == "card"


def test_a_new_id_never_takes_another_cards_name_or_id(ws):
    old = _add("Which runs failed")
    notebook.edit_cell(CORPUS, old["id"], title="How long did runs take")
    assert notebook.get_cell(CORPUS, old["id"])["slug"] == "long-runs-take"
    # its id stays, so a new card with its first question takes a number, and one with its new question too
    assert _add("Which runs failed?")["id"] == "runs-failed-2"
    assert _add("How long did runs take?")["id"] == "long-runs-take-2"


def test_an_older_random_id_and_every_name_resolve(ws):
    legacy = _legacy("How do the 16 runs compare in size")
    assert len(legacy["id"]) == 8 and not legacy["slug"]
    new = _add("Which runs failed")
    notebook.edit_cell(CORPUS, new["id"], title="Which runs errored")
    assert notebook.find_cell(ws, legacy["id"])[1]["id"] == legacy["id"]
    assert notebook.find_cell(ws, "runs-compare-size")[1]["id"] == legacy["id"]  # the name made when read
    assert notebook.find_cell(ws, "runs-failed")[1]["id"] == "runs-failed"  # its id
    assert notebook.find_cell(ws, "runs-errored")[1]["id"] == "runs-failed"  # its name now
    assert notebook.find_cell(ws, "no-such-card") is None


def test_a_ref_by_id_or_name_reads_the_card(ws):
    legacy = _legacy("How do the 16 runs compare in size")
    corpus = config.corpus_dir(CORPUS)
    for ref in (f"card:{legacy['id']}", "card:runs-compare-size"):
        got = refs.resolve(corpus, ref)
        assert got["cell_id"] == legacy["id"] and got["record"]["title"] == legacy["title"]


async def test_the_card_route_reads_a_card_by_its_name(client, ws):
    legacy = _legacy("How do the 16 runs compare in size")
    r = await client.get(f"/api/ws/{CORPUS}/cells/runs-compare-size")
    assert r.status_code == 200 and r.json()["id"] == legacy["id"]
    assert r.json()["slug"] == "runs-compare-size"  # the name its chip shows, though it was stored without one
    assert (await client.get(f"/api/ws/{CORPUS}/cells/{legacy['id']}")).json()["id"] == legacy["id"]
    assert (await client.get(f"/api/ws/{CORPUS}/cells/no-such-card")).status_code == 404


def test_a_deleted_card_takes_only_its_own_output_files(ws):
    runs, other = _add("Which runs"), _add("Which runs compare")
    assert (runs["id"], other["id"]) == ("runs", "runs-compare")
    d = ws / notebook.OUTPUTS_DIR
    d.mkdir(parents=True, exist_ok=True)
    for name in ("runs-0.txt", "runs-12.txt", "runs-compare-0.txt"):
        (d / name).write_text("x")
    notebook.delete_cell(CORPUS, "runs")
    assert sorted(p.name for p in d.iterdir()) == ["runs-compare-0.txt"]
