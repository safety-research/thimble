"""The workspaces this server knows, for the start page (the page whose URL names no workspace, or one this server does
not hold) and the top bar's switcher (frontend shell/WorkspaceList.tsx): GET /api/workspaces.

Each corpus of GET /corpora is one row, of one of three kinds, in this order:
- demo: a dataset `thimble demo` downloaded (demo_data.DATASETS), named by its folder: the folder is <dir>/<dataset>
  where `thimble demo` put it, $THIMBLE_HOME/demo (demo.default_dir) or a --dir that holds the SOURCES.md the command
  writes, or the workspace holds the pre-cache's mark (precached.MARKER), which names the dataset. `ready` when the
  mark is there: the orientation ran in advance and its outputs are installed. In DATASETS order.
- example: a worked example of custom views that `thimble demo --examples` opened, by its workspace's name
  (demo_examples.PREFIX), with the slug and name of the view it shows. By name.
- folder: any other folder, by its folder's name and path. By folder name.

A registered folder that is gone is left out, since its workspace cannot open. The route is a read like GET /corpora,
open to the page with or without the key's cookie (hook_auth guards writes only).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from . import config

router = APIRouter()

SOURCES_MD = "SOURCES.md"  # what `thimble demo` writes beside the datasets it downloads (demo.sources_md)


def _json(p: Path) -> dict[str, Any] | None:
    try:
        v = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return v if isinstance(v, dict) else None


def demo_dataset(folder: Path, mark: dict[str, Any] | None, demo_dir: Path) -> str | None:
    """The demo dataset a corpus folder holds (module note), None when it is no demo dataset."""
    from .demo_data import DATASETS  # noqa: PLC0415

    if mark is not None and str(mark.get("dataset") or "") in DATASETS:
        return str(mark["dataset"])
    if folder.name in DATASETS and (folder.parent == demo_dir or (folder.parent / SOURCES_MD).is_file()):
        return folder.name
    return None


def example_view(ws: Path, name: str) -> dict[str, str] | None:
    """The view an example's workspace shows, {slug, name}: the one demo_examples installed under the example's name,
    else the first installed; None when it has none."""
    from . import demo_examples, views  # noqa: PLC0415

    root = ws / views.LOCAL_SUBDIR / views.VIEWS_SUBDIR
    want = name[len(demo_examples.PREFIX):]
    try:
        slugs = [want] + sorted(p.name for p in root.iterdir() if p.is_dir() and p.name != want)
    except OSError:
        return None
    for slug in slugs:
        v = _json(root / slug / views.VIEW_JSON)
        if v is not None:
            return {"slug": slug, "name": str(v.get("name") or slug)}
    return None


def rows() -> list[dict[str, Any]]:
    """Every workspace as a row of the start page (module note)."""
    from . import demo, demo_examples, precached  # noqa: PLC0415
    from .corpus import list_corpora  # noqa: PLC0415
    from .demo_data import DATASETS  # noqa: PLC0415

    demo_dir = demo.default_dir()
    order = {n: i for i, n in enumerate(DATASETS)}
    out: list[dict[str, Any]] = []
    for c in list_corpora():
        name = str(c["name"])
        try:
            here = Path(c["path"]) if c.get("path") else config.corpus_dir(name)
        except ValueError:
            continue
        if not here.is_dir():
            continue
        shown = str(c.get("shown") or here)
        row: dict[str, Any] = {"name": name, "folder": Path(shown).name or name, "path": shown}
        ws = config.WORKSPACES_DIR / name
        mark = _json(ws / precached.MARKER)
        dataset = demo_dataset(here.resolve(), mark, demo_dir)
        if dataset is not None:
            ds = DATASETS[dataset]
            row.update(kind="demo", dataset=dataset, title=ds.title, blurb=ds.blurb or ds.title, ready=mark is not None)
        elif name.startswith(demo_examples.PREFIX):
            row.update(kind="example", view=example_view(ws, name))
        else:
            row["kind"] = "folder"
        out.append(row)
    kinds = {"demo": 0, "example": 1, "folder": 2}
    out.sort(key=lambda r: (kinds[r["kind"]], order.get(r.get("dataset") or "", 0),
                            (r["folder"] if r["kind"] == "folder" else r["name"]).lower(), r["path"]))
    return out


@router.get("/workspaces")
def list_workspaces() -> list[dict[str, Any]]:
    """The start page's rows (module note): {name, kind, folder, path}, with {dataset, title, blurb, ready} for a demo
    dataset and {view: {slug, name} | null} for an example."""
    return rows()
