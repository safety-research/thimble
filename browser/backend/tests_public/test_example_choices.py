"""Every choice of every menu of each worked example's terminal program (plugin/viewers/*/view.term.js) draws without
an error: Filter by (f), Rows (g) and Color by (c), each item chosen in turn from the view as it opens, None and Off
among them, with the example's sample labels on so that the menus offer labels too."""
from __future__ import annotations

import json

import pytest

from app import term_views, views
from test_term_views import DRAW_WRAP, _labels_on, needs_node
from test_views import EXAMPLES, _example_dir, inproc, samples  # noqa: F401 — the fixtures

MENUS = {"f": "Filter by", "g": "Rows", "c": "Color by"}  # a menu's key and the title of its frame
BROKEN = "the view could not be drawn"  # what the terminal kit draws in place of a view whose program threw


def _save(name: str) -> str:
    """The worked example `name` saved as a view of its sample with its terminal program; returns its slug."""
    d = _example_dir(name)
    raw = json.loads((d / "view.json").read_text("utf-8"))
    slug = EXAMPLES[name][0]
    views.write_view(name, slug, reader=(d / "reader.py").read_text("utf-8"), html=(d / "view.html").read_text("utf-8"),
                     term=(d / term_views.VIEW_TERM).read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return slug


def _menu(out: str, title: str) -> tuple[list[str], int] | None:
    """The items of the menu framed `title` in a drawing, and the one under ❯; None when no such menu shows."""
    lines = out.splitlines()
    top = next((i for i, x in enumerate(lines) if f"╭─ {title} " in x), None)
    if top is None:
        return None
    items: list[str] = []
    at = 0
    for x in lines[top + 1:]:
        s = x.strip()
        if s.startswith("╰"):
            break
        inner = s[1:]  # after the frame's │: `❯` or a space, then the item's name, a line that goes on indented further
        if len(inner) > 3 and inner[3] != " ":
            if inner[1] == "❯":
                at = len(items)
            items.append(inner[3:].split("  ")[0].strip())
    return items, at


@needs_node
@pytest.mark.parametrize("name", sorted(EXAMPLES))
async def test_every_choice_of_every_menu_draws_without_an_error(name, samples, inproc):
    """One program of the example, driven as draw_text drives one, each frame read after each key: a menu's items are
    chosen from its first down, each by its key, ↑ or ↓ and Enter, and every frame on the way is drawn."""
    slug = _save(name)
    if (_example_dir(name) / "labels.json").is_file():
        await _labels_on(name, name)
    views._bind_loop()
    p = term_views.Program(name, slug, wrap=DRAW_WRAP, keep=False)
    try:
        frame = await p.start(120, 36, "dark", None, text="plain")
        frame = await p.settle() or frame

        async def press(key: str, what: str, quiet: float = 0.05) -> str:
            """The frame after `key`; a move in a menu redraws at once, a choice may fetch, so it waits longer."""
            nonlocal frame
            await p.event(term_views._event_of(key, frame))
            frame = await p.settle(quiet) or frame
            text = str(frame.get("text") or "")
            assert BROKEN not in text, (what, text)
            return text

        assert BROKEN not in str(frame.get("text") or "")
        chosen = 0
        for key, title in MENUS.items():
            menu = _menu(await press(key, title), title)
            if menu is None:
                continue  # the view has no such control
            items, at = menu
            assert len(items) >= 2, (title, items)
            for _ in range(at):
                await press("up", title)
            for j, item in enumerate(items):
                if j:  # the menu opens on the choice, the item before this one
                    await press(key, title)
                    await press("down", title)
                await press("return", f"{title}: {item}", term_views.SETTLE_QUIET_S)
                chosen += 1
            again = _menu(await press(key, title), title)
            assert again and again[1] == len(items) - 1, (title, "the last item is the choice now", again)
            await press("escape", title)
        assert chosen, "the view has a menu to choose from"
    finally:
        await p.close()
