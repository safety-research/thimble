"""What thimble draws above a view's page (feature module, frontend files/ViewChrome.tsx): the files it reads, what it
leaves out, and the fields its reader derives.

- GET /api/ws/{c}/views/{slug}/shown: the claimed files, the files the reader hid with a reason at its last check
  (views.CHECKED, which the builder's checks write), and the derived fields view.json declares.
- GET /api/ws/{c}/views/{slug}/problems: the lines the reader could not read. thimble browser's readers do not report
  them yet, so the count is null (not known), which the page shows as nothing.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from . import corpus, home, views


def derived(meta: dict[str, Any]) -> list[dict[str, str]]:
    """view.json's derived fields as the page lists them: its `derived` list, then each field of its `records` that is
    derived "cleaned" or "computed" (a computed one is inferred), as thimble 0.8 read them."""
    out = [d for d in meta.get("derived") or [] if isinstance(d, dict)] if isinstance(meta.get("derived"), list) else []
    for rec in meta.get("records") if isinstance(meta.get("records"), list) else []:
        for f in rec.get("fields") if isinstance(rec, dict) and isinstance(rec.get("fields"), list) else []:
            if isinstance(f, dict) and f.get("derived") in ("cleaned", "computed") and f.get("name"):
                out.append({"record": str(rec.get("name") or ""), "field": str(f["name"]), "from": str(f.get("from") or ""),
                            "how": str(f.get("how") or ""), "kind": "inferred" if f["derived"] == "computed" else ""})
    return out


def shown(ws: str, slug: str, folder: Any, path: str | None = None) -> dict[str, Any]:
    d = views.view_dir(ws, slug)
    meta = views.read_meta(d) or {}
    checked = home.read_json(d / views.CHECKED, {}) or {}
    hidden = [h for h in checked.get("hidden") or [] if isinstance(h, dict) and (path is None or h.get("path") == path)]
    files = []
    for h in hidden:
        try:
            size = corpus.inside(folder, str(h.get("path") or "")).stat().st_size
        except (OSError, ValueError):
            size = 0
        files.append({"path": str(h.get("path")), "size": size, "read": 0, "why": str(h.get("why") or ""),
                      "claimed": True})
    n_files = 1 if path is not None else int(checked.get("claimed") or len(views.claimed(folder, views.claims_of(meta))))
    return {"files": n_files, "not_shown": {"count": len(files), "unexplained": 0, "files": files},
            "derived": derived(meta), "errors": []}


def register(ctx: Any) -> None:
    app = ctx.app

    def view_or_404(c: str, slug: str) -> None:
        try:
            d = views.view_dir(ctx.ws_of(c), slug)
        except KeyError:
            raise HTTPException(404, f"no such view: {slug}") from None
        if not (d / "view.json").is_file():
            raise HTTPException(404, f"no such view: {slug}")

    @app.get("/api/ws/{c}/views/{slug}/shown")
    def view_shown(c: str, slug: str, path: str | None = None) -> dict[str, Any]:
        view_or_404(c, slug)
        return shown(c, slug, ctx.folder_of(c), path)

    @app.get("/api/ws/{c}/views/{slug}/problems")
    def view_problems(c: str, slug: str, path: str | None = None) -> dict[str, Any]:
        view_or_404(c, slug)
        return {"count": None, "examples": []}
