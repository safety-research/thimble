"""The prompts that shape views: the dev agent's view ticket (prompts/dev-view.md), the orientation's Views section
(prompts/orient.md) and the rule that keeps a code ticket's change small (prompts/dev-ticket.md)."""
from __future__ import annotations

from app import prompts

VIEW_VALUES = {"name": "Inbox", "slug": "inbox", "why": "w", "claims": "tickets/*.jsonl", "arrangement": "a",
               "folder": "/v", "corpus": "/c", "examples": "/e", "check": "check"}
TICKET_VALUES = {"worktree": "/w", "ui_url": "u", "api_url": "a", "shots": "/s", "before_shot": "b", "title": "t",
                 "source": "ui", "body": "b", "target": "", "ticket": "0000"}


def test_the_smallest_change_rule_binds_code_tickets_and_not_views():
    view = prompts.render_dev("dev-view", VIEW_VALUES)
    ticket = prompts.render_dev("dev-ticket", TICKET_VALUES)
    assert "smallest change" in ticket and "Change nothing around the task" in ticket
    assert "smallest change" not in view and "Change nothing around the task" not in view


def test_a_view_ticket_asks_for_an_overview_scales_from_the_data_and_readable_marks():
    good = prompts.section("dev-view", "A good view")
    for words in ("It opens on an overview", "Its form fits the records", "Its scales fit the data",
                  "Everything on it is readable", "never the label colours"):
        assert words in good, words
    examples = prompts.section("dev-view", "Start from an example")
    assert "not their sizes, bins and field names" in examples


def test_the_orientation_looks_for_a_views_form_in_meaning_structure_and_findings():
    views = prompts.load("orient").split("#### Views", 1)[1].split("#### The report", 1)[0]
    for words in ("What the records are.", "How the records are structured.", "What your analysis found.",
                  "opens on an overview", "the sizes the page must fit"):
        assert words in views, words
    assert views.count("propose_view({") >= 4
