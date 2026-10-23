"""`set_layout`, main's tool, which lays the browser's main area out in one of the presets.

The server checks a call against the surfaces there are (Files, Canvas, Report, and each view as `view:<slug>`) and
sends it as the stream's `layout` record, which an open page applies. A page that loads later replays the record without
applying it, so a layout the analyst arranged since stays.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from . import tools

log = logging.getLogger("thimble.panes")

# each preset and how many panes it has (panes.ts PRESETS)
PRESETS = {"one": 1, "columns": 2, "rows": 2, "three": 3, "quadrants": 4}
# how a result names a preset's arrangement
WORDS = {"one": "in one pane", "columns": "side by side", "rows": "one over the other",
         "three": "with the first large beside the others stacked", "quadrants": "in four panes"}
BASE = ("files", "canvas", "report")


def surfaces(c: str) -> list[tuple[str, str]]:
    """(surface, name) of every surface a pane can show: Files, Canvas, Report, then each view that opens."""
    from . import views  # noqa: PLC0415 — views loads the viewers' machinery, which the tool registry leaves out

    out = [(s, s.capitalize()) for s in BASE]
    for v in views.list_views(c):
        if not v.get("ok"):
            continue
        if v.get("origin") == "builtin" and not views.claimed_paths(c, v):
            continue
        out.append((f"view:{v['slug']}", str(v.get("name") or v["slug"])))
    return out


def _surface(given: str, have: list[tuple[str, str]]) -> str | None:
    """The surface `given` names: files, canvas or report, `view:<slug>`, a view's slug, or a view's name."""
    g = given.strip()
    for sid, name in have:
        if g.casefold() in (sid.casefold(), sid.removeprefix("view:").casefold(), name.casefold()):
            return sid
    return None


async def tool_set_layout(ctx: Any, args: dict[str, Any]) -> Any:
    """The `set_layout` tool."""
    layout = str(args.get("layout") or "").strip().lower()
    if layout not in PRESETS:
        return tools.err(f"set_layout: `layout` must be one of {', '.join(PRESETS)}")
    raw = args.get("surfaces")
    if not isinstance(raw, list) or not all(isinstance(s, str) and s.strip() for s in raw):
        return tools.err("set_layout: `surfaces` is a list of the surfaces the panes show, in reading order")
    have = await asyncio.to_thread(surfaces, ctx.c)
    names = ", ".join(sid for sid, _ in have)
    picked = [_surface(s, have) for s in raw]
    unknown = [s for s, p in zip(raw, picked) if p is None]
    if unknown:
        return tools.err(f"set_layout: there is no surface {', '.join(map(repr, unknown))}; the surfaces are {names}")
    if len(set(picked)) != len(picked):
        return tools.err("set_layout: a surface shows in one pane at most, so name each once")
    n = PRESETS[layout]
    if len(picked) != n:
        return tools.err(f"set_layout: {layout} has {n} {'pane' if n == 1 else 'panes'}, so name {n}; the surfaces are {names}")
    from . import investigation  # noqa: PLC0415

    try:
        investigation.emit(ctx.c, investigation.MAIN, {"type": "layout", "layout": layout, "surfaces": picked})
    except Exception:  # noqa: BLE001 — a page that misses the record keeps its layout
        log.warning("set_layout: could not send the layout for %s", ctx.c, exc_info=True)
        return tools.err("set_layout: the layout could not be sent to the browser")
    listed = picked[0] if len(picked) == 1 else f"{', '.join(picked[:-1])} and {picked[-1]}"
    return tools.ok(tools.hint("set_layout-set", surfaces=listed, layout=WORDS[layout]))
