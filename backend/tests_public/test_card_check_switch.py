"""The Card check feature switch (features.auto `card_check`, thimble's config `agents.cardCheck.auto`): on, add_card's
and edit_card's results start the check of the card they name (card_check.after_tool); off, they start none."""
from __future__ import annotations

import json
from types import SimpleNamespace

from app import card_check, config, userconf

CORPUS = "mini"


async def _after(cid: str) -> None:
    res = SimpleNamespace(is_error=False, text=f"card:{cid}")
    got = await card_check.after_tool(CORPUS, "add_card", {"question": "q"}, res)
    assert got is res, "the result goes back unchanged"


async def test_the_card_check_follows_its_switch(workspaces_tmp, mini_dir, monkeypatch):
    config.workspace_dir(CORPUS)
    monkeypatch.setenv("THIMBLE_CARD_CHECK", "on")
    started: list[str] = []
    monkeypatch.setattr(card_check, "start", lambda c, cid, author, **kw: started.append(cid))
    monkeypatch.setattr(card_check, "card_of", lambda name, args, text, anchor=None: text.removeprefix("card:"))
    await _after("c1")
    assert started == ["c1"] and card_check.auto(CORPUS)
    conf = userconf.global_file()
    conf.parent.mkdir(parents=True, exist_ok=True)
    conf.write_text(json.dumps({"agents": {"cardCheck": {"auto": False}}}))
    assert not card_check.auto(CORPUS)
    await _after("c2")
    assert started == ["c1"], "no card check with the switch off"
