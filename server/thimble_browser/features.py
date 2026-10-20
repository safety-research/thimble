"""The feature modules of the server. Each is a module of this package with `register(ctx)` (app.Ctx), which adds its
routes to `ctx.app`, its tools to tools.EXTRA (tools.register) and its agents to agent.AGENTS. A feature's tool texts
go in prompts/browser/tools-<feature>.md, in the same form as tools.md.

Add a feature by adding its module's name to NAMES.
"""
from __future__ import annotations

import importlib
from types import ModuleType

NAMES: list[str] = [
    "files",
    "media",
    "view_head",
    "view_builds",
    "canvas_layout",
]


def load() -> list[ModuleType]:
    return [importlib.import_module(f"{__package__}.{name}") for name in NAMES]
