"""Labels: categories the analyst or Claude defines and applies to every unit of a scope (the records of files, the
canvas's cards, the report's sentences), by a model's judgment, a regex or Python code.

- store.py keeps the labels and their rows in the workspace's labels folder, which card code reads too
  (thimble.labels), and the filters;
- units.py says what a label labels; run.py runs a label over its units (classify.py: the model's calls,
  code_runner.py: code in the sandbox);
- api.py has the page's routes; chat.py the chat's tools (prompts/tools-labels.md), and define.py what a
  chat's definition does and what a `concept:` ref names.
"""
from __future__ import annotations

from typing import Any

from .. import agent, tools
from . import api, chat, define, run


def register(ctx: Any) -> None:
    run.SETTINGS["unsandboxed"] = bool(ctx.sessions.unsandboxed)
    api.register_routes(ctx)
    for name, fn in chat.HANDLERS.items():
        tools.register(name, fn)
    tools.REF_RESOLVERS["concept:"] = define.resolve_ref
    main = agent.AGENTS["main"]
    main.tools = main.tools + tuple(t for t in chat.TOOLS if t not in main.tools)
