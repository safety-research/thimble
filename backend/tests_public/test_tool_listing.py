"""Which tools thimble lists, and when (app/tools.py, plugin/bin/thimble-mcp, contract C5): before thimble is on,
load_thimble alone; once it is on, main's 0.8.0 set of 36 tools without load_thimble, every tool the guide names among
them; a turn that ends on load_thimble still needs words (its result is the guidance the model reads)."""
from __future__ import annotations

import re

from app import events, tools

# backticked words of the guide that name no tool: the events it describes (events.kinds) and Agent's argument
NOT_TOOLS = {"subagent_type"}


def test_every_tool_the_guide_names_is_listed(tmp_path):
    guide = events.render_prompts(events.SESSION_PROMPTS, str(tmp_path), True)
    named = set(re.findall(r"`([a-z]+(?:_[a-z]+)+)`", guide))
    listed = {t["name"] for t in tools.list(tools.ANALYST)}
    left = named - listed - set(events.kinds()) - NOT_TOOLS
    assert not left, f"the guide names tools thimble does not list: {sorted(left)}"
    assert {"add_card", "edit_card", "apply_label", "run_check", "read_ref"} <= named
