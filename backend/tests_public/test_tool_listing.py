"""Which tools thimble lists, and when (app/tools.py, plugin/bin/thimble-mcp, contract C5): before thimble is on,
load_thimble alone; once it is on, main's 0.8.0 set of 36 tools without load_thimble, every tool the guide names among
them; a turn that ends on load_thimble still needs words (its result is the guidance the model reads)."""
from __future__ import annotations

import re

from app import events, terminal_tools, tools

# backticked words of the guide that name no tool: the events it describes (events.kinds) and Agent's argument
NOT_TOOLS = {"subagent_type"}


def test_before_thimble_is_on_load_thimble_is_listed_alone():
    [entry] = tools.entry_listing()
    assert entry["name"] == tools.ENTRY_TOOL == "load_thimble"
    assert entry["input_schema"] == {"type": "object", "properties": {}}
    assert entry["description"].startswith("Turn on thimble in this session.") and "plan card" in entry["description"]
    assert tools.REGISTRY["load_thimble"].sessions == tools.MAIN_ONLY
    assert tools.REGISTRY["load_thimble"].handler == "app.activate:tool_load_handler"


def test_once_thimble_is_on_main_s_tool_set_is_listed_without_load_thimble():
    names = [t["name"] for t in tools.list(tools.ANALYST)]
    assert "load_thimble" not in names and len(names) == 36
    assert all(t["name"] != "load_thimble" for t in tools.list(tools.ANALYST, session="orient"))


def test_every_tool_the_guide_names_is_listed(tmp_path):
    guide = events.render_prompts(events.SESSION_PROMPTS, str(tmp_path), True)
    named = set(re.findall(r"`([a-z]+(?:_[a-z]+)+)`", guide))
    listed = {t["name"] for t in tools.list(tools.ANALYST)}
    left = named - listed - set(events.kinds()) - NOT_TOOLS
    assert not left, f"the guide names tools thimble does not list: {sorted(left)}"
    assert {"add_card", "edit_card", "apply_label", "run_check", "read_ref"} <= named


def test_a_turn_that_ends_on_load_thimble_still_needs_words():
    assert "load_thimble" in terminal_tools.READS
    assert terminal_tools.tool_name("load_thimble") not in terminal_tools.names()
    assert terminal_tools.tool_name("add_card") in terminal_tools.names()


def test_the_listing_metadata_names_claude_code_s_keys():
    assert tools.META_ALWAYS_LOAD == "anthropic/alwaysLoad" and tools.META_SEARCH_HINT == "anthropic/searchHint"
    assert tools.SEARCH_HINT == "card plan chart table label classify records thimble"
    assert tools.FEATURE_TOOLS == {"apply_label": "labels", "run_check": "checks"}
