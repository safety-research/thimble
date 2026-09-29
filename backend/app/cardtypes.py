"""Card types: a viewer folder whose view.json has a `card` block, which a card's code draws with
`thimble.card("<type>", labels=[…], **args)` (kernel_thimble.card).

The folder's files as a card type uses them:
  view.json  the view's manifest plus `card`: `use`, the one line main reads when it picks a type; `args`, a JSON Schema of
             the call's keywords (`ui: true` on those the card's own controls may change); `size`, the [min, max] height
             of the card's graphic in px; `example`, one call, for main's prompt
  card.py    card(index, **args), the data the page draws (kernel_thimble.CARD_DATA_MAX at most), and listing(data), the
             lines main reads and cites as card:<id>@out<i>#L<n>; thimble.card sets `reader`, the type's reader module,
             on it before each call
  reader.py  the view's reader (view_host.py), whose cached index card() reads and whose records() answers the card
             page's fetch
  view.html  the view's page, which draws a card from the `init` message the frame gets (viewer_bridge.js)

Where types come from:
  thimble's    plugin/viewers/<slug> with a `card` block and card.py, copied into the workspace (TYPES_DIR), since a
               card's kernel may see only the workspace and the corpus (kernel_wrap.py). Its claims are those of the
               workspace's view of the same slug, else what its reader's applies() names, asked once on the views kernel
               and kept (CLAIMS_FILE); a type whose applies() names none is left out.
  workspace's  a built view of the workspace with a `card` block and card.py.
refresh() writes REGISTRY_FILE, which thimble.card reads, and builds each type's index on the views kernel ahead of the
first card. prompt_text() is the {{card_types}} slot of prompts/shared.md."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from . import config, views
from .kernel_thimble import CARD_MIME, CARD_TYPES_FILE
from .ledger import read_json, write_json

log = logging.getLogger("thimble.cardtypes")

REGISTRY_FILE = CARD_TYPES_FILE  # in the workspace
TYPES_DIR = ".cardtypes"  # under the workspace's views folder: thimble's types copied in, and view_host.py
CLAIMS_FILE = "claims.json"  # in a copied type's folder: {claims, found} of its applies()
HOST_FILE = "view_host.py"
CARD_PY = "card.py"
TYPE_FILES = (views.VIEW_JSON, views.READER_PY, CARD_PY, views.VIEW_HTML)
SIZE = (240, 900)  # a type's height range when its view.json gives none
CARD_CALL = "thimble.card("

_locks: dict[str, asyncio.Lock] = {}


def card_block(raw: Any) -> dict[str, Any] | None:
    """view.json's `card` block normalised as {use, args, size, example}; None for a view that is no card type."""
    block = raw.get("card") if isinstance(raw, dict) else None
    if not isinstance(block, dict) or not str(block.get("use") or "").strip():
        return None
    args = block.get("args") if isinstance(block.get("args"), dict) else {"type": "object", "properties": {}}
    size = block.get("size")
    lo, hi = (size if isinstance(size, list) and len(size) == 2 and all(isinstance(x, int) for x in size) else SIZE)
    return {"use": " ".join(str(block["use"]).split()), "args": args, "size": [min(lo, hi), max(lo, hi)],
            "example": " ".join(str(block.get("example") or "").split())}


def _is_type(d: Path) -> bool:
    return (d / CARD_PY).is_file() and (d / views.READER_PY).is_file() and card_block(read_json(d / views.VIEW_JSON, {})) is not None


def own_types() -> list[str]:
    """The slugs of the card types thimble ships."""
    return sorted(d.name for d in views.VIEWERS_DIR.iterdir() if d.is_dir() and _is_type(d))


def types_dir(c: str) -> Path:
    return views.views_dir(c) / TYPES_DIR


def _copy_changed(src: Path, dst: Path) -> None:
    if not dst.is_file() or dst.read_bytes() != src.read_bytes():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)


def install_own(c: str, slug: str) -> Path:
    """thimble's type `slug` copied into the workspace, file by file where it changed; its folder there."""
    d = types_dir(c) / slug
    for name in TYPE_FILES:
        _copy_changed(views.VIEWERS_DIR / slug / name, d / name)
    _copy_changed(views.HOST_PY, types_dir(c) / HOST_FILE)
    return d


async def _applies(c: str, slug: str, reader: Path) -> dict[str, Any] | None:
    """What the reader's applies() says of the corpus's record files, as views.propose_builtins asks it."""
    from . import corpus  # noqa: PLC0415

    sources = await asyncio.to_thread(corpus.list_sources, config.corpus_dir(c))
    paths = [s["path"] for s in sources if str(s["path"]).endswith((".jsonl", ".csv"))]
    if not paths:
        return None
    req = {"slug": f"builtin-{slug}", "reader": str(reader.resolve()), "fp": "applies", "paths": [], "cache": None,
           "thimble": str(views.KERNEL_THIMBLE)}
    fit = await views._call(c, req, "applies", paths)
    return fit if isinstance(fit, dict) else None


async def claims_of(c: str, slug: str, d: Path) -> list[str]:
    """The files thimble's type `slug` reads here: the claims of the workspace's view of that slug, else those its
    applies() names, asked once and kept in CLAIMS_FILE. [] when it does not apply."""
    v = await asyncio.to_thread(views.read_built, c, slug)
    if v is not None and v["ok"]:
        return list(v["claims"])
    kept = read_json(d / CLAIMS_FILE, None)
    if isinstance(kept, dict) and isinstance(kept.get("claims"), list):
        return [str(x) for x in kept["claims"]]
    try:
        fit = await _applies(c, slug, d / views.READER_PY)
    except views.ReaderError as e:
        log.warning("%s: whether the card type %s applies is not known: %s", c, slug, e)
        return []
    claims = views._str_list((fit or {}).get("claims"))
    write_json(d / CLAIMS_FILE, {"claims": claims, "found": str((fit or {}).get("found") or "")})
    return claims


def version_of(d: Path) -> str:
    """The type's version: a hash of the files a card is made and drawn from."""
    h = hashlib.sha1()
    for name in TYPE_FILES:
        p = d / name
        h.update(p.read_bytes() if p.is_file() else b"")
        h.update(b"\0")
    return h.hexdigest()[:12]


def _entry(c: str, slug: str, d: Path, claims: list[str], origin: str) -> dict[str, Any]:
    """A type as REGISTRY_FILE holds it: what main reads (use, args, size, example), its files, and its index keyed and
    cached as the views kernel keys it (views._prepare), shared with the workspace's view of that slug when both read the
    same files with the same reader."""
    raw = read_json(d / views.VIEW_JSON, {})
    block = card_block(raw) or {}
    reader_src = (d / views.READER_PY).read_text("utf-8")
    files = views.claimed_files(c, {"claims": claims})
    fp = views.fingerprint(files, reader_src)
    cache = d / views.CACHE_SUBDIR
    view = views.read_built(c, slug)
    if origin == "thimble" and view is not None and view["ok"] and view["claims"] == claims:
        try:
            if (Path(view["dir"]) / views.READER_PY).read_text("utf-8") == reader_src:
                cache = views.cache_dir(c, view)
        except OSError:
            pass
    return {"name": " ".join(str(raw.get("name") or slug).split()), "slug": slug, "origin": origin, **block,
            "version": version_of(d), "dir": str(d.resolve()), "reader": str((d / views.READER_PY).resolve()),
            "card": str((d / CARD_PY).resolve()), "libs": views._libs(raw.get("libs")), "claims": claims,
            "paths": [f[0] for f in files], "fp": fp, "cache": str((cache / f"{fp}.index.pickle").resolve()),
            "host": str((types_dir(c) / HOST_FILE).resolve())}


def read_registry(c: str | None) -> dict[str, dict[str, Any]]:
    """{name: type} as refresh() last wrote them; {} before it ran."""
    if not c:
        return {}
    try:
        got = read_json(config.workspace_dir(c) / REGISTRY_FILE, {})
    except (OSError, ValueError, HTTPException):
        return {}
    types = got.get("types") if isinstance(got, dict) else None
    return types if isinstance(types, dict) else {}


async def refresh(c: str, *, warm: bool = True) -> dict[str, dict[str, Any]]:
    """The workspace's card types found again and written to REGISTRY_FILE, with each index built on the views kernel in
    the background (`warm`). Returns them by name."""
    lock = _locks.setdefault(c, asyncio.Lock())
    async with lock:
        types: dict[str, dict[str, Any]] = {}
        for slug in own_types():
            d = await asyncio.to_thread(install_own, c, slug)
            claims = await claims_of(c, slug, d)
            if claims:
                types[slug] = await asyncio.to_thread(_entry, c, slug, d, claims, "thimble")
        for slug, d in (await asyncio.to_thread(views._view_dirs, c)).items():
            v = await asyncio.to_thread(views.read_built, c, slug)
            if v is not None and v["ok"] and _is_type(Path(v["dir"])):
                await asyncio.to_thread(_copy_changed, views.HOST_PY, types_dir(c) / HOST_FILE)
                types[slug] = await asyncio.to_thread(_entry, c, slug, Path(v["dir"]), list(v["claims"]), "workspace")
        await asyncio.to_thread(write_json, config.workspace_dir(c) / REGISTRY_FILE, {"types": types})
    if warm:
        for t in types.values():
            asyncio.get_running_loop().create_task(_warm(c, t), name=f"cardtype-index-{t['slug']}")
    return types


def _request(t: dict[str, Any]) -> dict[str, Any]:
    """The views kernel's request for a type's reader (views._prepare's shape)."""
    return {"slug": t["slug"], "reader": t["reader"], "fp": t["fp"], "paths": t["paths"], "cache": t["cache"],
            "thimble": str(views.KERNEL_THIMBLE)}


async def _warm(c: str, t: dict[str, Any]) -> None:
    try:
        await views._call(c, _request(t), "index")
    except Exception as e:  # noqa: BLE001 — the first card builds it instead
        log.warning("%s: the index of the card type %s was not built ahead: %s", c, t.get("slug"), e)


async def refresh_quietly(c: str, *, warm: bool = True) -> dict[str, dict[str, Any]]:
    try:
        return await refresh(c, warm=warm)
    except Exception:  # noqa: BLE001 — a card that names a type says it is missing
        log.exception("%s: the card types were not found", c)
        return read_registry(c)


async def announce(c: str) -> None:
    """Refresh the types when main's session connects, and tell main of the types its prompt did not list."""
    from . import channel  # noqa: PLC0415

    before = set(read_registry(c))
    types = await refresh_quietly(c)
    new = {k: v for k, v in types.items() if k not in before}
    if new and channel.reachable(c):
        try:
            channel.post(c, "card_types", {"text": _lines(new), "types": ", ".join(new)})
        except HTTPException as e:
            log.info("%s: the card types were not announced: %s", c, e.detail)


def _signature(name: str, schema: Any) -> str:
    """One argument of a type in main's prompt: its name, what it takes and its description."""
    s = schema if isinstance(schema, dict) else {}
    if "enum" in s:
        takes = " or ".join(json.dumps(v) for v in s["enum"])
    elif s.get("type") == "array":
        item = s.get("items") if isinstance(s.get("items"), dict) else {}
        takes = f"[{' or '.join(json.dumps(v) for v in item['enum'])}]" if "enum" in item else (
            f"[{_keys(item)}]" if item.get("type") == "object" else "[…]")
    elif s.get("type") == "object":
        takes = _keys(s)
    else:
        takes = s.get("type") or "any"
    desc = " ".join(str(s.get("description") or "").split())
    return f"`{name}` {takes}" + (f": {desc}" if desc else "")


def _keys(s: dict[str, Any]) -> str:
    need = set(s.get("required") or [])
    return "{" + ", ".join(k if k in need else f"{k}?" for k in (s.get("properties") or {})) + "}"


def _lines(types: dict[str, dict[str, Any]]) -> str:
    out = []
    for name, t in types.items():
        props = (t.get("args") or {}).get("properties") or {}
        out.append(f"- `{name}`: {t.get('use') or ''}")
        if props:
            out.append("  Arguments: " + "; ".join(_signature(k, v) for k, v in props.items()) + ".")
        if t.get("example"):
            out.append(f"  For example: `{t['example']}`")
    return "\n".join(out)


def prompt_text(c: str | None) -> str:
    """The {{card_types}} slot: each type the workspace has, with its use, its arguments and an example call; '' for
    none."""
    return _lines(read_registry(c))


def card_of(bundles: Any) -> dict[str, Any] | None:
    """The card-type output among a card's output bundles, or None."""
    for b in bundles if isinstance(bundles, list) else []:
        if isinstance(b, dict) and isinstance(b.get(CARD_MIME), dict):
            return b[CARD_MIME]
    return None


def frame_document(c: str, name: str) -> str:
    """The page of the type `name` as a card's frame loads it (views.frame_document, marked as a card's), with no media
    route."""
    t = read_registry(c).get(name)
    if t is None:
        raise HTTPException(404, f"no card type {name!r} in this workspace")
    view = {"dir": t["dir"], "slug": t["slug"], "name": t["name"], "libs": t.get("libs") or []}
    return views.frame_document(view, card=True)


def labels_context(c: str, ids: list[str]) -> dict[str, Any]:
    """The labels context of a card (views.labels_context's shape): the labels it names, and no filter, since the Files
    filter only dims what a card drew."""
    ctx = views.labels_context(c, only=ids)
    return {"labels": ctx["labels"], "filter": None}


router = APIRouter()


@router.get("/ws/{c}/cardtypes/{name}/frame")
async def frame_route(c: str, name: str) -> HTMLResponse:
    """The type's page for a card's frame (frame_document), which loads no URL: a card draws what its code stored."""
    config.workspace_dir(c)
    return HTMLResponse(await asyncio.to_thread(frame_document, c, name))


class RecordsBody(BaseModel):
    query: Any = None
    card: str | None = None


@router.post("/ws/{c}/cardtypes/{name}/records")
async def records_route(c: str, name: str, body: RecordsBody) -> dict[str, Any]:
    """reader.records(index, query) for a card's page, under the labels the card names. 502 with the reader's error."""
    from . import notebook  # noqa: PLC0415

    config.workspace_dir(c)
    t = read_registry(c).get(name)
    if t is None:
        raise HTTPException(404, f"no card type {name!r} in this workspace")
    cell = await asyncio.to_thread(notebook.get_cell, c, body.card) if body.card else None
    made = card_of((cell or {}).get("outputs")) or {}
    ids = [str(x.get("id")) for x in made.get("labels") or [] if isinstance(x, dict) and x.get("id")]
    ctx = await asyncio.to_thread(labels_context, c, ids)
    try:
        return {"data": await views._call(c, {**_request(t), "labels": views._wire(ctx)}, "records", body.query)}
    except views.ReaderError as e:
        raise HTTPException(502, {"message": e.message, "traceback": e.detail[-views.ERROR_MAX:]}) from None
