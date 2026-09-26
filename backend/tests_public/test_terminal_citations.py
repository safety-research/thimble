"""Citations the terminal can read: main writes a citation in the chat as a Markdown link, which Claude Code's terminal
shows as its text, and the browser still gets the chip, since the mirror, reply_in_thread and a card's takeaway store it
in the [[…]] form. Web links and links to anything that is no ref stay links."""
from __future__ import annotations

import pytest

from app import agents, cite, session, threads

CORPUS = "mini"


@pytest.mark.parametrize("written, stored", [
    ("holds [4,579](card:06ea179f#pages/all) pages", "holds [[4,579|card:06ea179f#pages/all]] pages"),
    ("the networks card [↗](card:bde8b6d6) has it", "the networks card [[card:bde8b6d6]] has it"),
    ("made [1,815](card:38c4a0db#from%20the%20ten/dse(a)) edits", "made [[1,815|card:38c4a0db#from%20the%20ten/dse(a)]] edits"),
    ("[had it cached](board.jsonl#L6176)", "[[had it cached|board.jsonl#L6176]]"),
    ("[352](call:3f2a9c1b/12#L3) and [c-4471](view:inbox/c-4471)", "[[352|call:3f2a9c1b/12#L3]] and [[c-4471|view:inbox/c-4471]]"),
    ("[31](<card:ab12#outcome/merged>)", "[[31|card:ab12#outcome/merged]]"),
    ("[the docs](https://example.com/a) and [x](not a ref)", "[the docs](https://example.com/a) and [x](not a ref)"),
    ("[[4,579|card:06ea179f#pages/all]] and ![a plot](plot.png)", "[[4,579|card:06ea179f#pages/all]] and ![a plot](plot.png)"),
])
def test_a_markdown_link_to_a_ref_is_stored_as_its_citation(written, stored):
    assert cite.from_links(written) == stored
    assert cite.from_links(stored) == stored, "idempotent"


def test_main_s_chat_text_keeps_its_chips_and_loses_the_terminal_lines():
    text = "Most are on dse, [3,908](card:06ea179f#pages/dse) of them [↗](card:06ea179f).\n↳ thread hill: answered"
    assert session.visible(text) == "Most are on dse, [[3,908|card:06ea179f#pages/dse]] of them [[card:06ea179f]]."


def test_a_takeaway_and_a_thread_reply_take_the_link_form(workspaces_tmp):
    assert cite.normalise_markup("[31](card:ab12#outcome/merged) of 40") == "[[31|card:ab12#outcome/merged]] of 40"
    meta = agents._defaults({"id": "0c17e001", "kind": agents.KIND_THREAD, "role": "thread", "title": "t", "created_at": "t",
                             "parent": agents.MAIN_ID})
    agents.write_meta(CORPUS, meta)
    agents.paths(CORPUS, "0c17e001")[1].touch()
    threads.reply(CORPUS, "0c17e001", "Three picks [↗](card:ab12).", by="terminal")
    [rec] = [e for e in agents.read_events(agents.paths(CORPUS, "0c17e001")[1]) if e["type"] == "text"]
    assert rec["delta"] == "Three picks [[card:ab12]]."
