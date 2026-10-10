"""The libraries a custom card's page loads, inlined into its frame, so the card draws charts by hand in any library
while the frame still loads nothing from the network (its policy is the app's, http_guard.APP_CSP).

A custom card names them in its payload's `libs`, in view.json's words (view_libs): `vega`, `vega-lite` and
`vega-embed` are thimble's own builds (views.LIBS, which every install ships), each with what it needs ahead of it, and
any other entry is an npm package as name@version. Main installs a package with its own Bash call, `npm install
--ignore-scripts --cache .npm-cache <name>@<version>` in the workspace's card-libs folder (FOLDER, which main's fence
lets its Bash write), and Claude Code's permission mode decides it, as any install. add_card then bundles it into that
folder's lib/ (ensure: view_libs.ensure, which keeps the other cards' packages), recorded in lib/libs.json with its
version and SHA-256; the frame takes it from there (head), so the card draws offline, and a bundle whose bytes no longer
match its hash is not loaded.

The browser asks GET /api/ws/{c}/card-libs?libs=<entries, comma-separated> for the page's head (frontend
lib/frame.ts useCardLibs); the card harness carries the same answer in its request (render.request_for)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from . import config, view_libs, views

FOLDER = "card-libs"  # in the workspace: main's npm install, and lib/ with the bundles and libs.json

router = APIRouter()


def folder(c: str) -> Path:
    return config.workspace_dir(c) / FOLDER


def names(libs: Any) -> list[str]:
    """A card's `libs` in load order: thimble's own it names with what each needs ahead of it, then its npm packages."""
    return views._libs(libs)


async def ensure(c: str | None, libs: Any) -> list[str]:
    """The problems of a card's `libs`: entries that are no library, and npm packages not installed in FOLDER or not
    bundled; each package installed there is bundled into lib/ first. [] when every entry loads."""
    if bad := view_libs.problems(libs):
        return bad
    npm = [e for e in names(libs) if e not in views.LIBS]
    if not npm:
        return []
    if c is None:
        return ["a card's npm packages are installed in its workspace, and this call has none"]
    where = folder(c)
    return (await view_libs.ensure(c, "", where, npm, source=where, prune=False))["problems"]


def head(c: str, libs: Any) -> dict[str, Any]:
    """{head, problems}: the card's libraries as inline <script> and <style> elements in load order, and a line for
    each that is not here (also logged in the frame's console)."""
    tags: list[str] = []
    problems: list[str] = []
    for name in names(libs):
        p = views.LIBS.get(name)
        got = (("js", p.read_text("utf-8")) if p.is_file() else None) if p is not None else \
            view_libs.vendored(folder(c), name)
        if got is None:
            line = (f"the library {name} is not installed here" if p is not None else
                    f"the library {name} is not bundled in {folder(c) / view_libs.LIB_DIR}")
            problems.append(line)
            tags.append(f"<script>console.error({views._script_text(json.dumps(line))})</script>")
        elif got[0] == "css":
            tags.append(f"<style>{views._style_text(got[1])}</style>")
        else:
            tags.append(f"<script>{views._script_text(got[1])}</script>")
    return {"head": "".join(tags), "problems": problems}


def key(libs: Any) -> str:
    """The `libs` query the browser sends for a card's payload (lib/frame.ts useCardLibs)."""
    return ",".join(view_libs.entries(libs))


@router.get("/ws/{c}/card-libs")
async def libs_route(c: str, libs: str = "") -> dict[str, Any]:
    config.workspace_path(c)
    return await asyncio.to_thread(head, c, [x for x in libs.split(",") if x.strip()])
