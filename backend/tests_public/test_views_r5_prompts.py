"""Views round 5 (exploration): this pipeline's view prompts. The four guidelines, word for word, wherever the views'
principles were: main's `## Views`, the builder's `## A good view`, the reviewer, and the picker where there is one. The
builder's first screen shows the form the proposal chose, and the raw records open on demand, and main and the reviewer
hear the same. view-kit.md names every part of the view kit, in browser mode only."""
from __future__ import annotations

import re
from pathlib import Path

from app import prompts

REPO = Path(__file__).resolve().parents[2]
GUIDELINES = """Guidelines for excellent data views:

1. Overview first, zoom and filter, then details on demand. The first screen shows the whole dataset simply, possibly aggregated. Controls let the analyst go as deep as they need. A click on an element opens its record in a side panel.
2. Use a familiar interface that matches the data's structure and the task, such as a chat log as a chat app, a git repository as a GitHub page, emails as an inbox, or timestamped events on a timeline.
3. Encode the most important variables in the channels people read most accurately, so the comparisons the task needs are easy.
4. The analyst's attention is limited. Make something stand out only when it is worth the analyst's attention for the task at hand.
"""
FIRST_SCREEN = ("The first screen shows only the form the proposal chose. The list of raw records sits behind a control "
                "and opens on demand. Use a time range only when the task is about time.")
MAIN_FIRST_SCREEN = ("The first screen of each view you propose shows only the form you choose. The list of raw records sits "
                     "behind a control and opens on demand. Use a time range only when the task is about time.")
# `thimble.<name> = ...` in the kit's scripts that are no part of their own: another name of a part (colourBy, lanes),
# a call kept for views built before the side panel (expand), the card frame's bridge (card), and the label calls that
# dev-view.md's `## Labels in the page` gives (editLabel, newLabel)
NOT_PARTS = {"colourBy", "lanes", "expand", "card", "editLabel", "newLabel"}


def kit_parts() -> set[str]:
    found: set[str] = set()
    for js in (REPO / "backend" / "app").glob("viewer_*.js"):
        found |= set(re.findall(r"\bthimble\.([A-Za-z]+)\s*=(?!=)", js.read_text("utf-8")))
    return found - NOT_PARTS


def test_the_four_guidelines_are_word_for_word_where_the_views_principles_were():
    assert (REPO / "prompts" / "view-guidelines.md").read_text("utf-8") == GUIDELINES
    assert not (REPO / "prompts" / "view-principles.md").exists()
    names = ["main", "dev-view", "view-review"] + (["view-pick"] if (REPO / "prompts" / "view-pick.md").is_file() else [])
    for mode in ("browser", "terminal"):
        for name in names:
            assert GUIDELINES.strip() in prompts.load(name, mode), f"{name} ({mode})"
    review = prompts.load("view-review", "browser")
    assert "Principles." not in review and "colored scrollbar" not in review, "the reviewer's own list is gone"


def test_the_builder_opens_on_the_chosen_form_with_the_raw_records_on_demand():
    for mode in ("browser", "terminal"):
        text = prompts.load("dev-view", mode)
        assert FIRST_SCREEN in text
        assert "with records in view" not in text
        assert "The reviewer judges the page by established principles" not in text


def test_main_and_the_reviewer_hear_the_first_screen_too():
    """Main chooses the form, so it hears the first screen before it proposes; the reviewer judges by it."""
    for mode in ("browser", "terminal"):
        main = prompts.load("main", mode)
        assert MAIN_FIRST_SCREEN in main
        assert main.index(GUIDELINES.strip()) < main.index(MAIN_FIRST_SCREEN), "after the guidelines"
        review = prompts.load("view-review", mode)
        assert review.index(GUIDELINES.strip()) < review.index(FIRST_SCREEN) < review.index("Smells.")


def test_the_few_anchors_problem_offers_units_so_a_first_screen_of_groups_need_not_list_records():
    """A first screen of groups, such as bars, anchors few of the records the reader handed it; the label check's
    problem names the view's units beside the records' refs, so it does not ask for a list of records on the page."""
    from app import views  # noqa: PLC0415

    shot = {"ok": True, "state": "overview", "fetched_records": 400, "label_controls": 1,
            "shown": {"records": 2, "units": 0, "due": 0, "drawn": 0}}
    (problem,), _ = views.label_problems({"slug": "agents"}, [("board.jsonl", 100, 0)], [shot])
    assert "only 2 shown elements" in problem and "`view:agents/<key>`" in problem


def test_view_kit_names_every_part_of_the_view_kit_in_browser_mode_only():
    parts = kit_parts()
    assert {"colorBy", "table", "search", "diff", "text", "tree", "messages", "record", "chart", "timeline"} <= parts
    kit = prompts.load("view-kit", "browser")
    assert not [p for p in sorted(parts) if f"thimble.{p}(" not in kit], "a part of the kit view-kit.md never names"
    assert prompts.load("view-kit", "terminal").strip() == ""
    assert "thimble.recordCard(" not in prompts.load("dev-view", "terminal")
    assert kit.strip() in prompts.load("dev-view", "browser")
