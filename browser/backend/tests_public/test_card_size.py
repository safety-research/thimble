"""app.card_size: a card's body that draws taller than the canvas shows at rest (BODY_MAX, 800 px) is told to the card's
author with the author's next thimble call, once for each version of the card, whether the page measured it (POST
/ws/{c}/cells/{cid}/drawn, from the custom card's frame) or the card check's render did (render.Rendered.body). A body
that fits, and a call of another author, get no note, and a note waits only while its card stays the version it was
measured on. All data is made up."""
from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app import card_check, card_size, checkstore, notebook, render, tools

CORPUS = "mini"
TALL = "px tall at the card's width"


async def call(name: str, *, terminal: bool = True, **args):
    return await tools.call(CORPUS, name, args, actor="analyst", terminal=terminal)


def _cid(res) -> str:
    assert not res.is_error, res.text
    return re.search(r"^card:([A-Za-z0-9_-]+)$", res.text, re.M).group(1)


async def test_a_tall_card_the_page_measured_is_told_to_its_author_once_with_its_next_call(workspaces_tmp):
    card_size.forget(CORPUS)
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html="<div class='box'>runs</div>",
                          takeaway="Two runs failed."))
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as client:
        drawn = lambda h, card=cid: client.post(f"/api/ws/{CORPUS}/cells/{card}/drawn", json={"height": h})  # noqa: E731
        assert drawn(640).json() == {"told": False}  # it fits
        assert drawn(1460).json() == {"told": True}
        assert drawn(1460).json() == {"told": False}  # the same version, drawn again
        assert drawn(900, "no-such-card").status_code == 404
    # a call of another author (a browser chat) does not take the note
    assert TALL not in (await call("list_cards", terminal=False, group="all")).text
    told = (await call("list_cards", group="all")).text
    assert f"card:{cid}'s body draws 1460 {TALL}" in told and f"{card_size.BODY_MAX} px" in told
    assert TALL not in (await call("list_cards", group="all")).text  # once

    # a new version of the card is told again
    assert not (await call("edit_card", card=cid, html="<div class='box'>every run</div>")).is_error
    assert card_size.tell(CORPUS, notebook.get_cell(CORPUS, cid), 1200)


async def test_the_card_check_s_render_tells_the_author_a_body_past_the_limit(workspaces_tmp, monkeypatch):
    card_size.forget(CORPUS)
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html="<p>runs</p>",
                          takeaway="Two runs failed."))

    async def drawn(c, cell):
        return render.Rendered(png=b"made-up", box={"x": 16, "y": 16, "width": 720, "height": 1500}, body=1320.0)

    async def reading(*_a, **_k):
        return "the made-up reading failed"  # the check ends here, after the drawing

    monkeypatch.setattr(card_check, "_draw", drawn)
    monkeypatch.setattr(card_check, "_read", reading)
    check = checkstore.begin(CORPUS, cid, author="main")
    assert check
    await card_check._check(card_check._Run(CORPUS, cid, "main", str(check)))
    assert f"card:{cid}'s body draws 1320 {TALL}" in (await call("list_cards", group="all")).text


async def test_a_note_comes_with_no_call_that_replaced_or_deleted_the_version_it_measured(workspaces_tmp):
    card_size.forget(CORPUS)
    tall = "<p>every run</p>" * 80
    cid = _cid(await call("add_card", kind="custom", question="Which runs failed?", html=tall,
                          takeaway="Two runs failed."))
    from app.main import app

    with TestClient(app, base_url="http://127.0.0.1") as client:
        assert client.post(f"/api/ws/{CORPUS}/cells/{cid}/drawn", json={"height": 1460}).json() == {"told": True}
    # the edit that makes the card fit does not bring the note of the version it replaced, nor does a later call
    edited = await call("edit_card", card=cid, html="<p>2 of 56 runs failed</p>")
    assert not edited.is_error and TALL not in edited.text
    assert TALL not in (await call("list_cards", group="all")).text

    # a call that leaves the version as it was, such as a new takeaway, brings the note
    assert not (await call("edit_card", card=cid, html=tall)).is_error
    assert card_size.tell(CORPUS, notebook.get_cell(CORPUS, cid), 1460)
    retold = await call("edit_card", card=cid, takeaway="Two of the runs failed.")
    assert f"card:{cid}'s body draws 1460 {TALL}" in retold.text

    # the delete of the card does not bring its note
    assert not (await call("edit_card", card=cid, html=tall + "<p>run 81</p>")).is_error
    assert card_size.tell(CORPUS, notebook.get_cell(CORPUS, cid), 1480)
    assert TALL not in (await call("delete_card", card=cid)).text


def test_a_body_that_fits_or_a_card_made_by_hand_is_not_told(monkeypatch):
    card_size.forget("w")
    card = {"id": "c1", "kind": "custom", "created_by": "terminal", "payload": {"html": "<p>x</p>"}}
    monkeypatch.setattr(notebook, "get_cell", lambda c, cid, **_: dict(card) if (c, cid) == ("w", "c1") else None)
    assert not card_size.tell("w", card, card_size.BODY_MAX)
    assert not card_size.tell("w", {**card, "created_by": "user"}, 2000)
    assert card_size.tell("w", card, card_size.BODY_MAX + 1)
    assert card_size.take("w", "terminal") and not card_size.take("w", "terminal")
