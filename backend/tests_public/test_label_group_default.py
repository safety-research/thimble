"""A card made with no group never lands in a label's own group (bug hunt L18: once main made a label, its group, named
after the label, was the caller's last group, so every later card made with no group went into it, and "asks the user a
question" ended up holding an hours chart, a heatmap and a table of subagents). The label's card still gets its group;
a card with no group goes where it went before the label."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from app import cardrun, config, local, notebook, tools

CORPUS = "mini"


@pytest.fixture()
def term(workspaces_tmp, mini_dir, monkeypatch) -> Path:
    for name in ("THIMBLE_DEV", "THIMBLE_FRONTEND_URL", "THIMBLE_PORT"):
        monkeypatch.delenv(name, raising=False)
    tools._last_cell.clear()
    tools._last_group.clear()
    ws = config.workspace_dir(CORPUS)
    (ws / "trusted").mkdir(exist_ok=True)
    (ws / "trusted" / "launch.json").write_text(json.dumps({"mode": "terminal"}))
    monkeypatch.setenv("THIMBLE_WORKSPACES_DIR", str(config.WORKSPACES_DIR))
    yield mini_dir
    cardrun.CardWatch.stop_all()
    local._started.clear()


async def call(corpus: Path, tool: str, **args: Any) -> dict:
    return await local.call(tool, args, cwd=str(corpus))


def group_of(card: str) -> str:
    ws = config.workspace_dir(CORPUS)
    nb_id, _ = notebook.find_cell(ws, card)
    return notebook.read_notebook(ws, nb_id)["title"]


def card_id(res: dict) -> str:
    """The card a call made: add_card's result opens with it, apply_label's names the label's card."""
    body = "\n".join(b.get("text", "") for b in res["content"] if b.get("type") == "text")
    m = re.search(r"The label's card is \[\[card:([A-Za-z0-9_-]+)\]\]", body) or re.match(r"card:([A-Za-z0-9_-]+)", body)
    return m[1]


async def test_a_card_with_no_group_made_after_a_label_goes_where_cards_went_before_it(term):
    first = card_id(await call(term, "add_card", question="How many mugs?", kind="note", text="Nine.", group="Mug counts"))
    label = card_id(await call(term, "apply_label", scope="files", name="mentions a teapot",
                               predicate={"kind": "regex", "text": "teapot"}, paths=["agents/*.jsonl"]))
    after = card_id(await call(term, "add_card", question="How many saucers?", kind="note", text="Four."))
    assert group_of(first) == "Mug counts"
    assert group_of(label) == "mentions a teapot", "the label's card has its own group"
    assert group_of(after) == "Mug counts", "a card with no group stays out of the label's group"


async def test_a_label_made_first_leaves_the_next_card_in_the_default_group(term):
    plain = card_id(await call(term, "add_card", question="How many forks?", kind="note", text="Two."))
    home = group_of(plain)
    await call(term, "apply_label", scope="files", name="mentions a kettle", predicate={"kind": "regex", "text": "kettle"},
               paths=["agents/*.jsonl"])
    after = card_id(await call(term, "add_card", question="How many spoons?", kind="note", text="Six."))
    assert group_of(after) == home != "mentions a kettle"
