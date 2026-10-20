"""Images, audio and video of the folder, as the page shows them (feature module), and the libraries a custom card names.

- GET /api/ws/{c}/media?path= serves a media file of the folder for the Files tab and an example card.
- A view's page runs in a sandboxed frame, which sends no cookie, so it loads the files it claims from a route with a
  key in its path: GET /api/ws/{c}/views/{slug}/media/{key}?path=. The key is random, made for one view and one
  signed-in browser when the server writes the frame (views.media_key), and kept in memory only. The route answers only
  while that browser stays signed in, and only for an image, audio or video file the view claims.
- GET /api/ws/{c}/card-libs?libs= gives a custom card's frame the libraries it names (vega, vega-lite, vega-embed) as
  inline scripts, since the frame loads nothing by URL.

A media file is served with its type from its suffix (readers/refs.py MEDIA_TYPES: no SVG, no other type), with nosniff
and a policy that runs nothing should it be opened on its own. Range requests are answered, so a player seeks.
"""
from __future__ import annotations

import json
import secrets
import threading
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from fastapi.responses import FileResponse

from . import views
from .readers import base, refs

MEDIA_HEADERS = {"x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
                 "cache-control": "no-cache"}

_keys: dict[str, tuple[str, str, str]] = {}  # key -> (workspace, slug, browser)
_by_view: dict[tuple[str, str, str], str] = {}
_lock = threading.Lock()


def media_key(ws: str, slug: str, browser: str) -> str:
    """The key of a view's media route for one browser, made once and kept while the server runs."""
    with _lock:
        k = _by_view.get((ws, slug, browser))
        if k is None:
            k = secrets.token_urlsafe(32)
            _by_view[(ws, slug, browser)] = k
            _keys[k] = (ws, slug, browser)
        return k


def media_file(folder: Path, rel: str) -> tuple[Path, str]:
    """(the file, its media type) of a media file of the folder: a plain relative path with no dot part, of a
    MEDIA_TYPES type, a regular file inside the folder. 400, 415 or 404."""
    rel = str(rel or "")
    parts = rel.split("/")
    if not rel or "\\" in rel or "\0" in rel or any(not x or x.startswith(".") for x in parts):
        raise HTTPException(400, f"not a path in the folder: {rel!r}")
    media_type = refs.MEDIA_TYPES.get(Path(rel).suffix.lower())
    if media_type is None:
        raise HTTPException(415, f"{rel} is not an image, audio or video file")
    try:
        p = base.safe_path(folder, rel)
    except ValueError:
        raise HTTPException(404, f"no such file: {rel}") from None
    if not p.is_file():
        raise HTTPException(404, f"no such file: {rel}")
    return p, media_type


def card_libs(libs: str) -> dict[str, Any]:
    """{head, problems}: the libraries a custom card names, each with what it needs ahead of it, as inline scripts."""
    named = [x.strip() for x in libs.split(",") if x.strip()]
    tags, problems = [], []
    for name in named:
        if name not in views.VEGA:
            problems.append(f"thimble browser has only vega, vega-lite and vega-embed, not the library {name}")
    for name in views.lib_order(named):
        p = views.NODE_MODULES / views.VEGA[name]
        if p.is_file():
            tags.append(views._script(p.read_text(encoding="utf-8")))
        else:
            problems.append(f"the library {name} is not installed here")
    for line in problems:
        tags.append(views._script(f"console.error({json.dumps(line)})"))
    return {"head": "".join(tags), "problems": problems}


def register(ctx: Any) -> None:
    app, folder_of = ctx.app, ctx.folder_of
    views.media_key = media_key

    @app.get("/api/ws/{c}/media")
    def corpus_media(c: str, path: str) -> FileResponse:
        f, media_type = media_file(folder_of(c), path)
        return FileResponse(f, media_type=media_type, headers=MEDIA_HEADERS)

    def view_media(c: str, slug: str, path: str) -> FileResponse:
        folder = folder_of(c)
        try:
            d = views.view_dir(c, slug)
        except KeyError:
            raise HTTPException(404, f"no such view: {slug}") from None
        meta = views.read_meta(d)
        if meta is None:
            raise HTTPException(404, f"no such view: {slug}")
        f, media_type = media_file(folder, path)
        if not views.claims_path(views.claims_of(meta), path):
            raise HTTPException(403, f"the view {slug!r} does not claim {path}")
        return FileResponse(f, media_type=media_type, headers=MEDIA_HEADERS)

    @app.get("/api/ws/{c}/views/{slug}/media")
    def view_media_route(c: str, slug: str, path: str) -> FileResponse:
        return view_media(c, slug, path)

    @app.get("/api/ws/{c}/views/{slug}/media/{key}")
    def view_media_key_route(c: str, slug: str, key: str, path: str) -> FileResponse:
        """view_media for the view's sandboxed frame (module note): 404 for a key that is not this view's, or whose
        browser signed out."""
        with _lock:
            held = _keys.get(key)
        if held is None or held[:2] != (c, slug) or not ctx.auth.signed_in(held[2]):
            raise HTTPException(404, "no such media route")
        return view_media(c, slug, path)

    @app.get("/api/ws/{c}/card-libs")
    def card_libs_route(c: str, libs: str = "") -> dict[str, Any]:
        ctx.ws_of(c)
        return card_libs(libs)
