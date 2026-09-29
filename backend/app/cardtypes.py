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
  extension's  a view of an active extension with a `card` block and card.py, or a card-only type of one (cards/<slug>/,
               drawn by its card.html, read by the reader of the extension's view it names); extensions.card_types
               finds them in the workspace's copy of the extension. Its card.md is its guide in main's prompt.
  workspace's  a built view of the workspace with a `card` block and card.py.
refresh() writes REGISTRY_FILE, which thimble.card reads, and builds each type's index on the views kernel ahead of the
first card. prompt_text() is the {{card_types}} slot of prompts/shared.md: prompts/card-types.md with the types listed, or
nothing for a workspace with none.
Reshaping: Keep (keep_route) writes a patch of the arguments the type marks `ui` into the card's one thimble.card call
(rewrite_call), as literals in place of what the code gave, runs the card again and checks it; the card keeps the patch
as `kept_args`, which the card check gives back as they are (keep_kept). Open as view (as_view, from the card or main's
open_view tool) makes the type's view the workspace's, if it has none, turns the card's labels on and answers the
arguments the view's page draws its records by."""
from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from . import config, prompts, views
from .kernel_thimble import CARD_MIME, CARD_TYPES_FILE, _checked
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
PROMPT = "card-types"
LINE_MAX = 110  # characters of a rewritten call on one line; a longer one takes a line per argument

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


def _ext_entry(c: str, t: dict[str, Any]) -> dict[str, Any]:
    """An extension's type (extensions.card_types) as REGISTRY_FILE holds it, its index shared with the workspace's view
    of the type's view when the extension installed that view and it reads the same files with the same reader."""
    d, reader = Path(t["dir"]), Path(t["reader"])
    block = card_block({"card": t["block"]}) or {}
    reader_src = reader.read_text("utf-8")
    files = views.claimed_files(c, {"claims": t["claims"]})
    fp = views.fingerprint(files, reader_src)
    cache = Path(t["cache"])
    view = views.read_built(c, t["view"])
    if view is not None and view["ok"] and view["claims"] == t["claims"]:
        prop = views.read_proposal(c, t["view"]) or {}
        try:
            if prop.get("extension") == t["extension"] and (Path(view["dir"]) / views.READER_PY).read_text("utf-8") == reader_src:
                cache = views.cache_dir(c, view)
        except OSError:
            pass
    h = hashlib.sha1()
    for p in (d / "view.json" if t["page"] is None else d / "card.json", reader, d / CARD_PY,
              d / (t["page"] or views.VIEW_HTML)):
        h.update(p.read_bytes() if p.is_file() else b"")
        h.update(b"\0")
    return {"name": t["name"], "slug": t["slug"], "origin": "extension", "extension": t["extension"], "view": t["view"],
            **block, "guide": t["guide"], "version": h.hexdigest()[:12], "dir": str(d.resolve()),
            "view_dir": str(reader.parent.resolve()), "page": t["page"], "reader": str(reader.resolve()),
            "card": str((d / CARD_PY).resolve()), "libs": views._libs(t.get("libs")), "claims": t["claims"],
            "paths": [f[0] for f in files], "fp": fp, "cache": str((cache / f"{fp}.index.pickle").resolve()),
            "host": str((types_dir(c) / HOST_FILE).resolve())}


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
    the background (`warm`). An extension's type takes the place of thimble's of the same slug. Returns them by name."""
    from . import extensions  # noqa: PLC0415

    lock = _locks.setdefault(c, asyncio.Lock())
    async with lock:
        types: dict[str, dict[str, Any]] = {}
        ext_types = await asyncio.to_thread(extensions.card_types, c)
        mine = {t["slug"] for t in ext_types}
        for slug in own_types():
            if slug in mine:
                continue
            d = await asyncio.to_thread(install_own, c, slug)
            claims = await claims_of(c, slug, d)
            if claims:
                types[slug] = await asyncio.to_thread(_entry, c, slug, d, claims, "thimble")
        if ext_types:
            await asyncio.to_thread(_copy_changed, views.HOST_PY, types_dir(c) / HOST_FILE)
        for t in ext_types:
            try:
                types[t["slug"]] = await asyncio.to_thread(_ext_entry, c, t)
            except OSError as e:
                log.warning("%s: the card type %s of the extension %s was left out: %s", c, t["slug"], t["extension"], e)
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
            channel.post(c, "card_types", {"text": _block(new), "types": ", ".join(new)})
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
        if t.get("guide"):
            out.append("\n".join(f"  {ln}" if ln.strip() else "" for ln in str(t["guide"]).splitlines()))
    return "\n".join(out)


def _block(types: dict[str, dict[str, Any]]) -> str:
    return prompts.render(PROMPT, {"types": _lines(types)}).strip() if types else ""


def prompt_text(c: str | None) -> str:
    """The {{card_types}} slot: how main makes and reshapes a card of a card type, with each type the workspace has, its
    use, its arguments and an example call; '' for none."""
    return _block(read_registry(c))


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
    view = {"dir": t["dir"], "slug": t["slug"], "name": t["name"], "libs": t.get("libs") or [], "page": t.get("page")}
    return views.frame_document(view, card=True)


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
    ctx = await asyncio.to_thread(views.labels_context, c, ids)
    try:
        return {"data": await views._call(c, {**_request(t), "labels": views._wire(ctx)}, "records", body.query)}
    except views.ReaderError as e:
        raise HTTPException(502, {"message": e.message, "traceback": e.detail[-views.ERROR_MAX:]}) from None


class KeepError(ValueError):
    """Why Keep cannot write a patch into a card's code."""


def _py(v: Any) -> str:
    """A JSON value as a Python literal."""
    if v is None or isinstance(v, bool):
        return repr(v)
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ", ".join(_py(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{_py(str(k))}: {_py(x)}" for k, x in v.items()) + "}"
    raise KeepError(f"{v!r} is no JSON value")


def _is_card_call(node: ast.AST) -> bool:
    f = node.func if isinstance(node, ast.Call) else None
    return isinstance(f, ast.Attribute) and f.attr == "card" and isinstance(f.value, ast.Name) and f.value.id == "thimble"


def _offset(lines: list[str], lineno: int, col: int) -> int:
    """The character offset of an AST position (1-based line, UTF-8 byte column)."""
    return sum(len(x) for x in lines[: lineno - 1]) + len(lines[lineno - 1].encode("utf-8")[:col].decode("utf-8"))


def rewrite_call(code: str, patch: dict[str, Any], schema: dict[str, Any]) -> tuple[str, list[str]]:
    """`code` with its one thimble.card call's keyword arguments set to `patch`'s values as literals, and the names of
    the arguments the code computed, whose expressions the literals replace. A value that is None, empty or the
    schema's default removes the keyword. The rest of the code, and the call's other arguments, stay as written.
    KeepError when the code has no such call or more than one, or passes a patched argument through `**`."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        raise KeepError(f"the card's code does not parse: {e.msg}") from None
    calls = [n for n in ast.walk(tree) if _is_card_call(n)]
    if len(calls) != 1:
        raise KeepError("Keep changes a card whose code calls thimble.card once; ask for this change in the chat")
    call = calls[0]
    seg = lambda n: ast.get_source_segment(code, n) or ""  # noqa: E731
    props = (schema or {}).get("properties") or {}
    named = {kw.arg for kw in call.keywords if kw.arg is not None}
    if any(kw.arg is None for kw in call.keywords) and set(patch) - named:
        raise KeepError("the card's code passes its arguments with **; ask for this change in the chat")

    def dropped(k: str, v: Any) -> bool:
        p = props.get(k) if isinstance(props.get(k), dict) else {}
        return v is None or v == [] or v == {} or ("default" in p and v == p["default"])

    parts = [seg(a) for a in call.args]
    done, written = set(), []
    for kw in call.keywords:
        if kw.arg is None:
            parts.append(seg(kw))
        elif kw.arg in patch:
            try:
                ast.literal_eval(kw.value)
            except ValueError:
                written.append(kw.arg)
            done.add(kw.arg)
            if not dropped(kw.arg, patch[kw.arg]):
                parts.append(f"{kw.arg}={_py(patch[kw.arg])}")
        else:
            parts.append(seg(kw))
    parts += [f"{k}={_py(v)}" for k, v in patch.items() if k not in done and not dropped(k, v)]
    head = seg(call.func)
    lines = code.splitlines(keepends=True)
    start = _offset(lines, call.lineno, call.col_offset)
    end = _offset(lines, call.end_lineno, call.end_col_offset)
    one = f"{head}({', '.join(parts)})"
    line_start = code.rfind("\n", 0, start) + 1
    if "\n" in code[start:end] or start - line_start + len(one) > LINE_MAX:
        pad = " " * (start - line_start + 4)
        one = f"{head}(\n" + ",\n".join(pad + x for x in parts) + ")"
    return code[:start] + one + code[end:], written


def call_args(code: str) -> dict[str, Any] | None:
    """The literal keyword arguments of `code`'s one thimble.card call, a computed one as ...; None when the code has no
    such call or more than one."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return None
    calls = [n for n in ast.walk(tree) if _is_card_call(n)]
    if len(calls) != 1:
        return None
    out: dict[str, Any] = {}
    for kw in calls[0].keywords:
        if kw.arg is not None:
            try:
                out[kw.arg] = ast.literal_eval(kw.value)
            except ValueError:
                out[kw.arg] = ...
    return out


def type_of(c: str, cell: dict[str, Any]) -> dict[str, Any]:
    """The registry's entry of the type a card draws. HTTPException 400 for a card of no type, 404 for a type the
    workspace no longer has."""
    made = card_of(cell.get("outputs"))
    if not made:
        raise HTTPException(400, f"card:{cell.get('id')} draws no card type")
    t = read_registry(c).get(str(made.get("type")))
    if t is None:
        raise HTTPException(404, f"no card type {made.get('type')!r} in this workspace")
    return t


def keep_patch(c: str, cell: dict[str, Any], patch: Any) -> tuple[str, dict[str, Any], list[str]]:
    """The card's code with `patch` written into its call, the patch checked against the type's schema (each key an
    argument the type marks `ui`), and the arguments the code computed that the patch writes out as literals.
    HTTPException 400 saying what is wrong."""
    t = type_of(c, cell)
    if not isinstance(patch, dict) or not patch:
        raise HTTPException(400, "Keep needs the arguments to change")
    schema = t.get("args") or {}
    props = schema.get("properties") or {}
    checked = {}
    for k, v in patch.items():
        p = props.get(k)
        if not isinstance(p, dict) or not p.get("ui"):
            raise HTTPException(400, f"Keep does not change `{k}`; the card changes {', '.join(n for n, q in props.items() if isinstance(q, dict) and q.get('ui'))}")
        try:
            checked[k] = None if v is None else _checked(p, v, f"`{k}`")
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
    try:
        code, written = rewrite_call(str(cell.get("code") or ""), checked, schema)
    except KeepError as e:
        raise HTTPException(400, str(e)) from None
    return code, checked, written


def kept_in_force(c: str, cell: dict[str, Any]) -> dict[str, Any]:
    """The arguments Keep set on a card (its `kept_args`) that its code still gives as Keep wrote them: {} once an undo
    or an edit changed them."""
    kept = cell.get("kept_args")
    if not isinstance(kept, dict) or not kept:
        return {}
    have = call_args(str(cell.get("code") or ""))
    if have is None:
        return {}
    try:
        props = (type_of(c, cell).get("args") or {}).get("properties") or {}
    except HTTPException:
        return {}

    def written(k: str, v: Any) -> Any:
        p = props.get(k) if isinstance(props.get(k), dict) else {}
        return None if v is None or v == [] or v == {} or ("default" in p and v == p["default"]) else v

    return kept if all(have.get(k) == written(k, v) for k, v in kept.items()) else {}


def same_code(a: str, b: str) -> bool:
    """Whether two codes say the same, the keyword arguments of their thimble.card calls in any order."""
    def norm(code: str) -> str | None:
        try:
            tree = ast.parse(code)
        except SyntaxError:
            return None
        for n in ast.walk(tree):
            if _is_card_call(n):
                n.keywords.sort(key=lambda kw: (kw.arg is None, kw.arg or ""))
        return ast.dump(tree)

    x = norm(a)
    return x is not None and x == norm(b)


def keep_kept(c: str, cell: dict[str, Any], code: str) -> str | None:
    """`code`, a revision of the card's code, with the arguments Keep set that are in force written back into its call;
    None when they cannot be."""
    kept = kept_in_force(c, cell)
    if not kept:
        return code
    try:
        return rewrite_call(code, kept, type_of(c, cell).get("args") or {})[0]
    except (KeepError, HTTPException):
        return None


class KeepBody(BaseModel):
    patch: dict[str, Any]
    dry: bool = False


@router.post("/ws/{c}/cells/{cell_id}/keep")
async def keep_route(c: str, cell_id: str, body: KeepBody) -> dict[str, Any]:
    """Keep: the card's call rewritten with the patch of arguments the analyst's reshaping in its page made, then the
    card run again and checked (notebook.regenerate's run and check). {cell, written}: the card as stored and the
    arguments its code computed that Keep wrote out as literals. With `dry`, only whether Keep can write the patch:
    {cell: None, written}, or the 400 it would give."""
    from . import notebook  # noqa: PLC0415

    hit = await asyncio.to_thread(notebook.find_cell, config.workspace_dir(c), cell_id)
    if hit is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    await refresh_quietly(c, warm=False)
    cell = hit[1]
    code, patch, written = keep_patch(c, cell, body.patch)
    if body.dry:
        return {"cell": None, "written": written}
    kept = {**kept_in_force(c, cell), **patch}
    await asyncio.to_thread(notebook.edit_cell, c, cell_id, code=code, by="user", kept_args=kept)
    return {"cell": await notebook._regenerate(c, cell_id), "written": written}


def install_view(c: str, t: dict[str, Any]) -> None:
    """thimble's type `t` as the workspace's view of its slug, claiming the files the type reads, under a built proposal
    of the analyst's that keeps the digest of the files as installed (`installed`)."""
    d = Path(t["dir"])
    raw = read_json(d / views.VIEW_JSON, {})
    with views._proposals_lock:
        items = [p for p in views.list_proposals(c) if p.get("slug") != t["slug"]]
        items.append({"slug": t["slug"], "name": views.title_case(raw.get("name") or t["slug"]),
                      "why": " ".join(str(raw.get("why") or "").split()), "claims": list(t["claims"]), "arrangement": "",
                      "proposed_by": "analyst", "status": "queued", "orientation": False, "ts": views._now()})
        views._save_proposals(c, items)
    views.write_view(c, t["slug"], name=raw.get("name") or t["slug"], why=raw.get("why") or "", claims=list(t["claims"]),
                     accepts=raw.get("accepts"), declares=raw.get("declares"), default=bool(raw.get("default")),
                     libs=raw.get("libs"), reader=(d / views.READER_PY).read_text("utf-8"),
                     html=(d / views.VIEW_HTML).read_text("utf-8"))
    views.update_proposal(c, t["slug"], installed=views.view_digest(views.views_dir(c) / t["slug"]))


def _stale_install(c: str, t: dict[str, Any], v: dict[str, Any]) -> bool:
    """Whether the workspace's view of thimble's type `t` is thimble's own install, unchanged since (its proposal's
    `installed` digest), and older than the type's files."""
    prop = views.read_proposal(c, t["slug"]) or {}
    d, src = Path(v["dir"]), Path(t["dir"])
    if not prop.get("installed") or views.view_digest(d) != prop["installed"]:
        return False
    return any((d / n).read_bytes() != (src / n).read_bytes() for n in (views.READER_PY, views.VIEW_HTML))


async def as_view(c: str, cell_id: str) -> dict[str, Any]:
    """Open as view: the view of the card's type, made the workspace's from thimble's type when it has none or has
    thimble's older install of it, with the card's labels turned on in Files. {slug, query}: `query` is {card, title,
    args}, the card and the arguments the view's page draws its records by."""
    from . import notebook  # noqa: PLC0415

    cell = await asyncio.to_thread(notebook.get_cell, c, cell_id)
    if cell is None:
        raise HTTPException(404, f"no such card: {cell_id}")
    made = card_of(cell.get("outputs"))
    t = type_of(c, cell)
    if t["origin"] == "extension":
        slug = t["view"]
        v = await asyncio.to_thread(views.read_built, c, slug)
        if v is None or not v["ok"]:
            await asyncio.to_thread(views.install_viewer, c, slug, Path(t["view_dir"]), t["claims"], why="",
                                    proposed_by="analyst", orientation=False, extension=t["extension"])
        return {"slug": slug, "query": await _turn_on(c, cell_id, cell, made)}
    v = await asyncio.to_thread(views.read_built, c, t["slug"])
    if v is None or not v["ok"] or (t["origin"] == "thimble" and v["origin"] == "workspace"
                                    and await asyncio.to_thread(_stale_install, c, t, v)):
        if t["origin"] != "thimble":
            raise HTTPException(409, f"the view {t['slug']} does not pass its checks")
        await asyncio.to_thread(install_view, c, t)
    return {"slug": t["slug"], "query": await _turn_on(c, cell_id, cell, made)}


async def _turn_on(c: str, cell_id: str, cell: dict[str, Any], made: dict[str, Any] | None) -> dict[str, Any]:
    """The card's labels turned on in Files; the query the view's page draws the card's records by."""
    from . import concepts  # noqa: PLC0415

    for k in (made or {}).get("labels") or []:
        try:
            await asyncio.to_thread(concepts.show_concept, c, str(k.get("id")), True)
        except HTTPException as e:
            log.info("%s: the label %s of card:%s was not turned on: %s", c, k.get("id"), cell_id, e.detail)
    args = {k: x for k, x in ((made or {}).get("args") or {}).items() if x is not None}
    return {"card": cell_id, "title": str(cell.get("title") or ""), "args": args}


@router.post("/ws/{c}/cells/{cell_id}/as-view")
async def as_view_route(c: str, cell_id: str) -> dict[str, Any]:
    """as_view for the card's Open as view."""
    return await as_view(c, cell_id)


OPEN_VIEW = "open-view"  # the stream's record that opens a view in Files (frontend lib/events.ts)


async def tool_open_view(ctx: Any, args: dict[str, Any]) -> Any:
    """The `open_view` tool: a card of a card type opened as its view (as_view), or a view opened as it is, with no
    card's arguments; sent to the browser as the stream's OPEN_VIEW record."""
    from . import investigation, notebook, panes, tools  # noqa: PLC0415

    raw_card = re.sub(r"^(?:card|cell):", "", str(args.get("card") or "").strip().strip("[]")).split("#", 1)[0].split("@", 1)[0]
    raw_view = str(args.get("view") or "").strip()
    if bool(raw_card) == bool(raw_view):
        return tools.err("open_view: give `card`, a card of a card type, or `view`, a view to open with no card's arguments")
    if raw_card:
        cell = await asyncio.to_thread(notebook.get_cell, ctx.c, raw_card)
        if cell is None:
            return tools.err(f"open_view: there is no card:{raw_card}")
        if not card_of(cell.get("outputs")):
            return tools.err(f"open_view: card:{raw_card} draws no card type, so it has no view")
        await refresh_quietly(ctx.c, warm=False)
        try:
            opened = await as_view(ctx.c, raw_card)
        except HTTPException as e:
            return tools.err(f"open_view: {e.detail}")
        slug, query = opened["slug"], opened["query"]
    else:
        have = await asyncio.to_thread(panes.surfaces, ctx.c)
        sid = panes._surface(raw_view, have)
        if sid is None or not sid.startswith("view:"):
            names = ", ".join(s.removeprefix("view:") for s, _ in have if s.startswith("view:")) or "none"
            return tools.err(f"open_view: there is no view {raw_view!r}; the views are {names}")
        slug, query = sid.removeprefix("view:"), None
    try:
        investigation.emit(ctx.c, investigation.MAIN, {"type": OPEN_VIEW, "slug": slug, "query": query})
    except Exception:  # noqa: BLE001 — a page that misses the record stays as it is
        log.warning("open_view: could not send the view for %s", ctx.c, exc_info=True)
        return tools.err("open_view: the view could not be sent to the browser")
    if query:
        return tools.ok(tools.hint("open_view-card", card=f"card:{raw_card}", view=slug))
    return tools.ok(tools.hint("open_view-view", view=slug))
