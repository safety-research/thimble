"""The prompts that shape views: the dev agent's view ticket (prompts/dev-view.md), the orientation's Views section
(prompts/orient.md) and the rule that keeps a code ticket's change small (prompts/dev-ticket.md)."""
from __future__ import annotations

import re

from app import prompts, views

VIEW_VALUES = {"name": "Inbox", "slug": "inbox", "why": "w", "claims": "tickets/*.jsonl", "spec": "- Unit: a",
               "folder": "/v", "corpus": "/c", "examples": "/e", "check": "check"}
TICKET_VALUES = {"worktree": "/w", "ui_url": "u", "api_url": "a", "shots": "/s", "before_shot": "b", "title": "t",
                 "source": "ui", "body": "b", "target": "", "ticket": "0000"}
ORIENT_VIEWS_WORDS_MAX = 300


def test_the_smallest_change_rule_binds_code_tickets_and_not_views():
    view = prompts.render_dev("dev-view", VIEW_VALUES)
    ticket = prompts.render_dev("dev-ticket", TICKET_VALUES)
    assert "smallest change" in ticket and "Change nothing around the task" in ticket
    assert "smallest change" not in view and "Change nothing around the task" not in view


def test_a_view_ticket_asks_for_an_overview_scales_from_the_data_and_a_fit_to_the_pane():
    good = prompts.section("dev-view", "A good view")
    for words in ("It opens on an overview", "Its scales come from the data", "It fits its pane"):
        assert words in good, words
    assert "methods to copy, not layouts" in prompts.section("dev-view", "Worked examples")


def test_a_view_ticket_makes_labels_first_class_and_leaves_their_controls_to_the_labels_pane():
    labels = prompts.section("dev-view", "Labels")
    for words in ("the Labels pane beside the view, outside its frame", "`data-anchor`", "`thimble.marked(ref)`",
                  "`thimble.kept(ref)`", "`thimble.onLabels(fn)`", "while a label is on, it alone colours records",
                  "No label controls", "no label toggle, checkbox, menu or clickable legend"):
        assert words in labels, words


def _orient_views() -> str:
    return prompts.load("orient").split("#### Views", 1)[1].split("#### The report", 1)[0]


def test_the_orientation_s_views_section_is_short_examples_of_three_kinds():
    section = _orient_views()
    for words in ("Semantic, the data's own genre:", "Structural, a shape in the data:", "Clustered, grouped by labels:",
                  "opens on an overview, then lets the analyst zoom, filter and open details"):
        assert words in section, words
    assert "ideas, not a menu" in section and "any form" in section
    assert section.count(" → ") >= 9, "short examples, data → view"
    assert "propose_view({" not in section, "no whole calls"
    assert len(re.findall(r"\S+", section)) <= ORIENT_VIEWS_WORDS_MAX


def test_the_orientation_makes_labels_first_class_and_proposes_viewers_for_file_types():
    section = _orient_views()
    assert "Labels are first class" in section and "obeys the Labels pane's filter" in section
    assert "propose a viewer with the extension's glob" in section and "`**/*.vtt`" in section
    assert "offers it beside Raw" in section
    tools = prompts.section("tools", "propose_view")
    assert "a viewer for one unusual file type" in tools and "the extension's glob, such as **/*.vtt" in tools
    assert "asks for a viewer of that file type" in prompts.section("dev-view", "The ticket")


def test_the_prompts_name_the_width_the_pictures_are_shot_at():
    width = f"{views.SHOT_SIZE[0]} px wide"
    assert width in prompts.load("dev-view") and width in prompts.load("view-review")
