"""Labels: categories Claude or the analyst defines and applies to every record of a scope, by a model's judgment, a
regex or code, such as "asks for a refund". A label shows as colors in the Files tab and as a label card.

It owns the labels' routes and runs (the labels package), the chat's label tools (labels/chat.py), the `Labels` part of
the chat agent's prompt (prompts/labels.md, the terminal's own words through prompts/shared.json) and, on the page, the
Labels pane of the Files tab and the colors it gives records.
"""
from __future__ import annotations

from .. import labels
from ..labels import chat
from . import Feature

FEATURE = Feature(
    name="labels",
    title="Labels",
    does="Claude sorts records into categories you can see and check: colors in the Files tab, and a card with the "
         "count of each value.",
    register=labels.register,
    tools=dict(chat.HANDLERS),
    main_tools=chat.TOOLS,
    prompt="labels.md",
    page=("labels",),
)
