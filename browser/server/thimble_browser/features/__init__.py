"""thimble browser's features, registered in one place.

The core of the server is the sign-in, the folder of files and its readers, the chats with their agent loop, the
settings and the event stream. Everything else is a feature: one module of this package that says what it adds, in
one small shape (Feature):

- `register(ctx)` adds its routes to the server (app.Ctx), and its hooks on other parts, once at the start;
- `tools` are the tools it implements, by name (their texts are `## <name>` sections of prompts/tools*.md);
- `main_tools` are the tools the chat agent gets while the feature is on;
- `prompt` is its part of the chat agent's prompt, a file under prompts/, read while the feature is on;
- `page` names the page's surfaces it owns, which the page's own registry (frontend src/features.ts) draws.

A feature is on unless Settings turns it off (settings.json `features`). Its routes stay registered either way, so the
page and the stored work never break, but while it is off the chat agent has neither its tools nor its prompt part,
its after-turn work does not run, and the page does not show its surfaces.

Add a feature by adding its module to MODULES.
"""
from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

MODULES: tuple[str, ...] = ("marks", "cards", "labels", "report", "views")


@dataclass
class Feature:
    name: str
    title: str
    does: str
    register: Callable[[Any], None] | None = None
    tools: dict[str, Callable[[Any, dict[str, Any]], Awaitable[Any]]] = field(default_factory=dict)
    main_tools: tuple[str, ...] = ()
    prompt: str | None = None
    page: tuple[str, ...] = ()


def all_features() -> list[Feature]:
    return [importlib.import_module(f"{__package__}.{name}").FEATURE for name in MODULES]


def is_on(name: str) -> bool:
    """Whether the feature `name` is on now: Settings' `features`, on by default."""
    from .. import settings  # noqa: PLC0415

    return bool(settings.read()["features"].get(name, True))


def on() -> list[Feature]:
    return [f for f in all_features() if is_on(f.name)]


def main_tools() -> tuple[str, ...]:
    """The chat agent's feature tools now, in the registry's order (a fixed order keeps the request cacheable)."""
    out: list[str] = []
    for f in on():
        out += [t for t in f.main_tools if t not in out]
    return tuple(out)


def main_prompt_parts() -> list[str]:
    return [f.prompt for f in on() if f.prompt]


def register_all(ctx: Any) -> None:
    from .. import tools  # noqa: PLC0415

    for f in all_features():
        for name, fn in f.tools.items():
            tools.register(name, fn)
        if f.register:
            f.register(ctx)


def listing() -> list[dict[str, Any]]:
    """The features as Settings lists them."""
    return [{"name": f.name, "title": f.title, "does": f.does, "on": is_on(f.name), "page": list(f.page)}
            for f in all_features()]
