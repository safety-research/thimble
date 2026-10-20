"""Labels: categories the analyst or Claude defines and applies to every unit of a scope (the records of files, the
canvas's cards, the report's sentences), by a model's judgment, a regex or Python code.

- store.py keeps the labels and their rows in the workspace's labels folder, which card code reads too
  (thimble.labels), and the filters;
- units.py says what a label labels; run.py runs a label over its units (classify.py: the model's calls,
  code_runner.py: code in the sandbox);
- api.py has the page's routes; chat.py the chat's tools (prompts/tools-labels.md), and define.py what a
  chat's definition does and what a `concept:` ref names;
- asks.py asks the analyst before a model reads many records, and shows a run in the chat that started it.
"""
from __future__ import annotations

from typing import Any

from .. import tools
from . import api, asks, define, run


def register(ctx: Any) -> None:
    """The routes and the `concept:` refs; the feature (features/labels.py) registers the chat's tools."""
    run.SETTINGS["unsandboxed"] = bool(ctx.sessions.unsandboxed)
    api.register_routes(ctx)
    asks.register_routes(ctx)
    tools.REF_RESOLVERS["concept:"] = define.resolve_ref
