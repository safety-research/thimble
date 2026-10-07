"""Documents: their types, storage, frames, the tools that save and check them, and routes.

A type is {slug, name, description, renderer, prompt, rubric}; the built-ins (report, story, slides) are backed by
prompts/report-*.md and custom types live under workspaces/<c>/report-types/<slug>/. A video is a custom type made from
the video extension's report type, and one written while the video was built in becomes one when it is first read
(_migrate_video). A document is stored at investigations/<inv>/<slug>.json, its frame at <slug>.frame.json, its earlier
generations under <slug>/.

No model runs here. The writer (write_session.py) reads a type's form with read_ref("type:<name>") and saves with
write_document (a whole document in markdown) or edit_document (one passage). Each save runs the citation check
(report.verify_and_tag); the report checks (checks.py) hear every `report` record through _emit."""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import cite, config, investigation, ledger, material, notebook, prompts, refs, slides, undo
from .ledger import atomic_write_text, read_json, unlinked, write_json
from .report import (_Refs, _collapse, _cut, _new_id, _put_text, _replace_text, _title_ok, plain_text, reopen_comment,
                     settle_carried_comment)
from .schemas import CELL_REF, SENTENCE_TEXT, TAGS
from .story import StoryBody

log = logging.getLogger("thimble.report_types")

RENDERERS = ("document", "slides", "story", "custom", "video")
BUILTIN_SLUGS = ("report", "story", "slides")
LEGACY_VIDEO = "video"  # the slug of the video while it was built in, and the id of the video extension's report type
RESERVED = set(BUILTIN_SLUGS) | {"brief", "findings", "run", "investigation", "events", "notes", "critiques", "reports",
                                 "types", "draft", "versions", "presets", "new"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
MATERIAL_SLOT = "{{material}}"  # the slot a legacy custom type's text may hold, taken out by type_form
PROMPT_MAX = 40_000
RUBRIC_MAX = 20_000
SCHEMA_MAX = 40_000
ANALYST = "analyst"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")


router = APIRouter()


# --------------------------------------------------------------------------- a custom type's schema


def undescribed(schema: dict) -> dict:
    """A deep copy of a schema with every `description` removed, for a shape already described once in the tool."""
    if isinstance(schema, dict):
        return {k: undescribed(v) for k, v in schema.items() if k != "description"}
    if isinstance(schema, list):
        return [undescribed(v) for v in schema]
    return schema


PLACEHOLDERS = ("$sentence", "$cell", "$graphic")
_CELL_SCHEMA = {"type": "string", "pattern": CELL_REF,
                "description": f"A card that draws a figure, as card:<id>: {material.FIGURE_WORDS}."}


def _graphic_schema() -> dict[str, Any]:
    from . import story  # noqa: PLC0415

    return {**story._GRAPHIC, "type": ["object", "null"]}


def placeholder_of(node: Any) -> str | None:
    if isinstance(node, dict):
        for k in PLACEHOLDERS:
            if node.get(k) is True:
                return k
    return None


def _nodes(node: Any):
    yield node
    if isinstance(node, dict):
        for v in node.values():
            yield from _nodes(v)
    elif isinstance(node, list):
        for v in node:
            yield from _nodes(v)


def expand_schema(raw: Any) -> dict[str, Any]:
    """The tool's input schema from a custom type's schema: placeholders replaced, a root `title` ensured,
    `additionalProperties: false` on every object. 400 when the schema is not usable."""
    if not isinstance(raw, dict) or raw.get("type", "object") != "object":
        raise HTTPException(400, "the document schema must be a JSON Schema object (type: object) with properties")
    if len(json.dumps(raw)) > SCHEMA_MAX:
        raise HTTPException(400, f"the document schema is longer than {SCHEMA_MAX} characters")
    if not any(placeholder_of(n) == "$sentence" for n in _nodes(raw)):
        raise HTTPException(400, 'the document schema must place at least one {"$sentence": true} so the document\'s claims carry refs')
    described: set[str] = set()
    real = {"$sentence": SENTENCE_TEXT, "$cell": _CELL_SCHEMA}

    def walk(node: Any) -> Any:
        ph = placeholder_of(node)
        if ph:
            base = json.loads(json.dumps(_graphic_schema() if ph == "$graphic" else real[ph]))
            out = undescribed(base) if ph in described else base
            described.add(ph)
            if isinstance(node.get("description"), str) and node["description"].strip():
                out["description"] = node["description"]
            return out
        if isinstance(node, dict):
            out = {k: walk(v) for k, v in node.items()}
            if out.get("type") == "object" and isinstance(out.get("properties"), dict) and "additionalProperties" not in out:
                out["additionalProperties"] = False
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    schema = walk(raw)
    schema.setdefault("type", "object")
    props = schema.setdefault("properties", {})
    if not isinstance(props, dict):
        raise HTTPException(400, "the document schema's `properties` must be an object")
    if "title" not in props:
        props["title"] = {"type": "string", "minLength": 1, "description": "A short title stating the main point."}
    req = [r for r in schema.get("required", []) if isinstance(r, str)] if isinstance(schema.get("required"), list) else []
    if "title" not in req:
        req.append("title")
    schema["required"] = req
    return schema


# A page: a custom type whose document is one HTML document (`html`) plus its claims as sentence records (`claims`), so
# the checks and filters have spans as for any other type. The frontend shows the html in a sandboxed iframe.
PAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "minLength": 1, "description": "A short title stating the main point."},
        "html": {"type": "string", "minLength": 1,
                 "description": "The whole page as one complete HTML document with its own <style> and no scripts."},
        "claims": {"type": "array", "minItems": 1, "items": {"$sentence": True},
                   "description": "Every claim the page makes about the data, one sentence each, cited inline in [[...]] form, in the order the page makes them."},
    },
    "required": ["title", "html", "claims"],
    "additionalProperties": False,
}
PAGE_PROMPT = "A page over the analysis, laid out as the cards call for."
HTML_MAX = 2_000_000


# --------------------------------------------------------------------------- types


def types_dir(c: str) -> Path:
    return config.workspace_dir(c) / "report-types"


def _type_dir(c: str, slug: str) -> Path:
    return types_dir(c) / slug


def _check_slug(slug: str, *, custom: bool = True) -> str:
    s = (slug or "").strip().lower()
    if not SLUG_RE.match(s):
        raise HTTPException(400, f"slug {slug!r} must match {SLUG_RE.pattern}")
    if custom and s in RESERVED:
        raise HTTPException(400, f"slug {s!r} is reserved")
    return s


def type_paragraph_text(renderer: str) -> str:
    """A form's own text, prompts/report-<form>.md: what the writer is asked for and the markdown it saves it in."""
    return prompts.load(prompts.TYPE_FILES[renderer]).strip()


def _builtin(slug: str) -> dict[str, Any]:
    if slug == "report":
        prompt, renderer = type_paragraph_text("document"), "document"
        desc = "The run's report: what the data is, the main takeaways, one section per finding, short limitations."
    elif slug == "slides":
        prompt, renderer = type_paragraph_text("slides"), "slides"
        desc = "A short narrative slideshow over the report's verified material: one point per slide, with the same citations."
    else:
        prompt, renderer = type_paragraph_text("story"), "story"
        desc = "A scrolling story in the style of a newsroom's interactive graphics: a title, a one-sentence answer, then sections, each a headline with its cited text beside the card that carries it."
    out = {"slug": slug, "name": slug.capitalize(), "description": desc, "renderer": renderer, "prompt": prompt, "rubric": "",
           "created_by": "thimble", "ts": None, "builtin": True}
    return out


def _migrate_video(c: str) -> None:
    """A workspace's video written while the video was built in: its type is made, from the video extension's report
    type, so it opens, is written and is exported as any video."""
    d = _type_dir(c, LEGACY_VIDEO)
    written = (config.workspace_dir(c) / "investigations").glob(f"*/{LEGACY_VIDEO}.json")
    if (d / "type.json").is_file() or not any(written):
        return
    try:
        unlinked(config.workspace_dir(c), d / "type.json")
    except ValueError as e:
        log.warning("%s: the video's type was not made: %s", c, e)
        return
    d.mkdir(parents=True, exist_ok=True)
    atomic_write_text(d / "prompt.md", "")
    write_json(d / "type.json", {"slug": LEGACY_VIDEO, "created_by": "thimble", "ts": _now(), "name": "Video",
                                 "description": "", "renderer": "video", "preset": LEGACY_VIDEO})


def read_type(c: str, slug: str) -> dict[str, Any] | None:
    """A type record with its prompt and rubric text; None when neither a built-in nor a custom type has the slug."""
    if slug in BUILTIN_SLUGS:
        return _builtin(slug)
    if slug == LEGACY_VIDEO:
        _migrate_video(c)
    d = _type_dir(c, slug)
    meta = read_json(d / "type.json", None)
    if not isinstance(meta, dict):
        return None
    renderer = str(meta.get("renderer") or "document")
    if renderer not in RENDERERS:
        renderer = "document"
    prompt_file, rubric_file, component_file = d / "prompt.md", d / "rubric.md", d / "renderer.tsx"
    prompt = prompt_file.read_text("utf-8") if prompt_file.is_file() else ""
    made_from = preset(str(meta.get("preset") or ""), c) if meta.get("preset") else None
    if made_from and not prompt.strip():
        prompt = made_from["prompt"]
    out = {
        "slug": slug,
        "name": str(meta.get("name") or slug),
        "description": str(meta.get("description") or ""),
        "renderer": renderer,
        "prompt": prompt,
        "rubric": rubric_file.read_text("utf-8") if rubric_file.is_file() else "",
        "created_by": str(meta.get("created_by") or ANALYST),
        "ts": meta.get("ts"),
        "updated": meta.get("updated"),
        "forked_from": meta.get("forked_from"),
        "builtin": False,
    }
    if made_from:
        out["preset"] = made_from["id"]
    out["page"] = renderer == "custom" and bool(meta.get("page"))
    if out["page"]:
        out["schema_source"] = PAGE_SCHEMA
        out["schema"] = expand_schema(PAGE_SCHEMA)
    elif renderer == "custom":
        out["schema_source"] = meta.get("schema") if isinstance(meta.get("schema"), dict) else {}
        try:
            out["schema"] = expand_schema(out["schema_source"])
        except HTTPException:
            out["schema"] = out["schema_source"]
        # the component is kept as text; nothing installs or renders it (a page is the open form)
        out["component"] = component_file.read_text("utf-8") if component_file.is_file() else ""
    return out


def _require_type(c: str, slug: str) -> dict[str, Any]:
    t = read_type(c, slug)
    if t is None:
        raise HTTPException(404, f"no report type {slug!r}")
    return t


def list_types(c: str) -> list[dict[str, Any]]:
    """The built-ins in their order, then the workspace's custom types by creation time."""
    out = [_builtin(s) for s in BUILTIN_SLUGS]
    _migrate_video(c)
    root = types_dir(c)
    customs: list[dict[str, Any]] = []
    for d in sorted(root.iterdir()) if root.is_dir() else ():
        if d.is_dir() and SLUG_RE.match(d.name) and d.name not in RESERVED:
            t = read_type(c, d.name)
            if t:
                customs.append(t)
    customs.sort(key=lambda t: (str(t.get("ts") or ""), t["slug"]))
    return out + customs


def _clean_prompt(prompt: str) -> str:
    p = (prompt or "").replace("\r\n", "\n").strip()
    if not p:
        raise HTTPException(400, "prompt is required")
    if len(p) > PROMPT_MAX:
        raise HTTPException(400, f"prompt is longer than {PROMPT_MAX} characters")
    return p + "\n"


def write_type(c: str, slug: str, *, name: str, description: str, renderer: str, prompt: str, rubric: str,
               schema: Any = None, component: str | None = None, created_by: str = ANALYST,
               forked_from: str | None = None, create: bool = False, page: bool = False,
               preset_id: str | None = None) -> dict[str, Any]:
    """Store a custom type; a `custom` renderer needs its schema and its checked component source, unless it is a
    `page` (renderer custom, the page schema, no component; an empty prompt takes PAGE_PROMPT). A type made from a
    preset (`preset_id`) keeps an empty prompt.md and reads the preset's text (read_type) until its text is edited."""
    slug = _check_slug(slug)
    if renderer not in RENDERERS:
        raise HTTPException(400, f"renderer must be one of {', '.join(RENDERERS)}")
    d = _type_dir(c, slug)
    existing = read_json(d / "type.json", None) if d.is_dir() else None
    if create and isinstance(existing, dict):
        raise HTTPException(409, f"a report type {slug!r} already exists")
    from_preset = preset_id or (existing.get("preset") if isinstance(existing, dict) else None)
    if from_preset and preset(str(from_preset), c) is None:
        raise HTTPException(400, f"no preset {from_preset!r}")
    if from_preset and (prompt or "").strip() == (preset(str(from_preset), c) or {}).get("prompt"):
        prompt = ""  # the preset's own text, as read_type gave it: the file stays its one source
    if len(rubric or "") > RUBRIC_MAX:
        raise HTTPException(400, f"rubric is longer than {RUBRIC_MAX} characters")
    page = renderer == "custom" and (page or bool(isinstance(existing, dict) and existing.get("page")))
    if page:
        schema, component = PAGE_SCHEMA, None
        prompt = (prompt or "").strip() or ("" if from_preset else PAGE_PROMPT)
    elif renderer == "custom":
        if schema is None and isinstance(existing, dict):
            schema = existing.get("schema")
        expand_schema(schema)
        if component is None and (d / "renderer.tsx").is_file():
            component = (d / "renderer.tsx").read_text("utf-8")
        if not (component or "").strip():
            raise HTTPException(400, "a custom renderer needs its component source")
    try:
        unlinked(config.workspace_dir(c), d / "type.json")
    except ValueError as e:
        raise HTTPException(409, f"the type's folder cannot be written: {e}") from None
    d.mkdir(parents=True, exist_ok=True)
    meta = dict(existing) if isinstance(existing, dict) else {"slug": slug, "created_by": created_by, "ts": _now()}
    meta.update(name=_collapse(name) or slug, description=(description or "").strip(), renderer=renderer, updated=_now())
    if forked_from:
        meta["forked_from"] = forked_from
    if renderer == "custom":
        meta["schema"] = schema
    else:
        meta.pop("schema", None)
    if page:
        meta["page"] = True
    else:
        meta.pop("page", None)
    if from_preset:
        meta["preset"] = from_preset
    atomic_write_text(d / "prompt.md", _clean_prompt(prompt) if not from_preset or (prompt or "").strip() else "")
    atomic_write_text(d / "rubric.md", (rubric or "").replace("\r\n", "\n").strip() + "\n")
    if renderer == "custom" and component is not None:
        atomic_write_text(d / "renderer.tsx", component.replace("\r\n", "\n"))
    write_json(d / "type.json", meta)
    return read_type(c, slug) or meta


def delete_type(c: str, slug: str) -> None:
    """Remove a custom type, and its documents with it: each investigation's document, frame and earlier generations
    move under that investigation's `.deleted/<slug>-<stamp>/`, so a type made later under the same slug starts empty
    and nothing written is lost. A write pending for it is forgotten."""
    slug = _check_slug(slug)
    d = _type_dir(c, slug)
    if not (d / "type.json").is_file():
        raise HTTPException(404, f"no report type {slug!r}")
    root = config.workspace_dir(c) / "investigations"
    for inv in sorted(root.iterdir()) if root.is_dir() else ():
        held = [p for p in (inv / f"{slug}.json", inv / f"{slug}.frame.json", inv / slug) if p.exists()]
        if not held:
            continue
        dest = inv / ".deleted" / f"{slug}-{_stamp()}"
        dest.mkdir(parents=True, exist_ok=True)
        for p in held:
            os.replace(p, dest / p.name)
    _writes.pop((c, slug), None)
    shutil.rmtree(d)


# --------------------------------------------------------------------------- presets and new documents
# A preset is a ready-made document type, prompts/types/<id>.md (prompts.TYPES_DIR): name and description as
# frontmatter, the type's text as the body. A document made from one reads its text from the file each time (read_type).
# The report types of the workspace's active extensions are presets there too (extensions.report_types).

PRESET_RE = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
# the kinds of new document besides the presets: a page, and a type of each renderer written from a brief
NEW_KINDS = ("page", "document", "slides", "story")


def _extension_presets(c: str | None) -> list[dict[str, Any]]:
    if not c:
        return []
    from . import extensions  # noqa: PLC0415

    builtin = set(prompts.names_in(prompts.TYPES_DIR))
    try:
        return [{k: t[k] for k in ("id", "name", "description", "renderer", "prompt", "extension")}
                for t in extensions.report_types(c)
                if PRESET_RE.match(t["id"]) and t["id"] not in builtin and t["id"] not in NEW_KINDS]
    except Exception:  # noqa: BLE001 — a broken extension leaves thimble's own presets
        log.warning("%s: the extensions' report types could not be read", c, exc_info=True)
        return []


def preset(pid: str, c: str | None = None) -> dict[str, Any] | None:
    """{id, name, description, renderer, prompt} of the preset `pid`, or of an active extension's report type in
    workspace `c` (with its `extension`); None when there is none."""
    if not PRESET_RE.match(pid or ""):
        return None
    if pid not in prompts.names_in(prompts.TYPES_DIR):
        return next((t for t in _extension_presets(c) if t["id"] == pid), None)
    try:
        front, body = prompts.frontmatter(f"{prompts.TYPES_DIR}/{pid}")
    except prompts.PromptError:
        log.exception("the preset %s does not read", pid)
        return None
    # a preset is a document of the document renderer, or a page (`renderer: page`), one html document with its claims
    renderer = "page" if str(front.get("renderer") or "").strip().lower() == "page" else "document"
    return {"id": pid, "name": _collapse(front.get("name")) or pid, "description": _collapse(front.get("description")),
            "renderer": renderer, "prompt": body}


def presets(c: str | None = None) -> list[dict[str, Any]]:
    """Every preset, in the order of their files' names, then the report types of workspace `c`'s active extensions."""
    return [p for p in (preset(pid) for pid in prompts.names_in(prompts.TYPES_DIR)) if p] + _extension_presets(c)


def new_kinds(c: str | None = None) -> list[str]:
    """What a new document can be: each preset's id, then NEW_KINDS."""
    return [p["id"] for p in presets(c)] + list(NEW_KINDS)


def _free_slug(c: str, base: str) -> str:
    """`base`, or `base-2`, `base-3`, …, the first no type holds."""
    taken = {t["slug"] for t in list_types(c)}
    for n in range(1, 1000):
        s = base if n == 1 else f"{base[:37]}-{n}"
        if s not in taken and s not in RESERVED:
            return s
    return f"type-{_stamp()[-6:]}"


def _free_name(c: str, name: str) -> str:
    """`name`, or `name 2`, `name 3`, …, the first no type's name holds, case aside."""
    taken = {str(t.get("name") or "").strip().lower() for t in list_types(c)}
    for n in range(1, 1000):
        s = name if n == 1 else f"{name} {n}"
        if s.lower() not in taken:
            return s
    return name


def create_document_type(c: str, kind: str, *, name: str | None = None, brief: str = "", slug: str | None = None,
                         created_by: str = ANALYST) -> dict[str, Any]:
    """A new document for + New and start_writing: a preset by its id, a page, or a document, slides or story type whose
    text
    is the brief. Its name and slug are made unique. Emits `report {slug, status: created}`. 400 for an unknown kind
    or a
    missing brief; 409 when `slug` is taken."""
    kind = (kind or "").strip().lower()
    made_from = preset(kind, c) if kind not in NEW_KINDS else None
    if kind not in NEW_KINDS and made_from is None:
        raise HTTPException(400, f"no kind of document {kind!r}; the kinds are {', '.join(new_kinds(c))}")
    default = made_from["name"] if made_from else "Page" if kind == "page" else kind.capitalize()
    name = _free_name(c, _collapse(name) or default)
    slug = _check_slug(slug) if slug else _free_slug(c, _fallback_slug(name))
    brief = (brief or "").strip()
    if kind == "page":
        t = write_type(c, slug, name=name, description="", renderer="custom", prompt=brief, rubric="",
                       created_by=created_by, create=True, page=True)
    elif made_from:
        page = made_from["renderer"] == "page"
        renderer = "custom" if page else "video" if made_from["renderer"] == "video" else "document"
        t = write_type(c, slug, name=name, description=made_from["description"], renderer=renderer,
                       prompt="", rubric="", created_by=created_by, create=True, page=page, preset_id=kind)
    elif not brief:
        raise HTTPException(400, "a document of your own needs its brief, what it is for")
    else:
        t = write_type(c, slug, name=name, description="", renderer=kind, prompt=brief, rubric="", created_by=created_by,
                       create=True)
    _emit(c, {"type": "report", "slug": t["slug"], "status": "created", "by": created_by})
    return t


# --------------------------------------------------------------------------- what a type asks its writer for


def _words(text: str) -> int:
    return len(text.split())


def doc_words(doc: dict[str, Any]) -> int:
    """The words a reader sees in a stored document."""
    parts = [_collapse(doc.get("title"))]
    answer = doc.get("answer") if isinstance(doc.get("answer"), dict) else None
    if answer:
        parts.append(plain_text(str(answer.get("text") or "")))
    for u in units(doc):
        parts.append(_collapse(u.get("heading")))
        parts += [plain_text(str(s.get("text") or "")) for s in unit_sentences(u)]
    return _words(" ".join(p for p in parts if p))


def type_form(t: dict[str, Any]) -> str:
    """What read_ref("type:<name>") returns, the one text a writer reads for a type: a built-in's form, or a custom
    type's
    own text then its form's text, then the rubric. A legacy `## Material` heading and {{material}} slot are taken
    out."""
    text = str(t.get("prompt") or "").strip()
    if not t.get("builtin", False) or not text:
        text = text.replace(MATERIAL_SLOT, "")
        text = re.sub(r"(?:^|\n)#{1,3}\s*Material\s*\n", "\n", text).strip()
        if t.get("renderer") in prompts.TYPE_FILES:
            text = (text + "\n\n" if text else "") + type_paragraph_text(str(t["renderer"]))
    rubric = str(t.get("rubric") or "").strip()
    if rubric:
        text = (text + "\n\n" if text else "") + rubric
    return text or type_paragraph_text("document")


# --------------------------------------------------------------------------- document storage


def doc_file(c: str, inv_id: str, slug: str) -> Path:
    return investigation.inv_dir(c, inv_id) / f"{slug}.json"


def frame_file(c: str, inv_id: str, slug: str) -> Path:
    return investigation.inv_dir(c, inv_id) / f"{slug}.frame.json"


def _with_defaults(doc: dict[str, Any]) -> dict[str, Any]:
    from . import story  # noqa: PLC0415

    story.upgrade(doc)
    doc.setdefault("comments", [])
    # a legacy `locked` list of edited sentences locks nothing: only a block the analyst locked is locked
    # (set_block_lock)
    doc.pop("locked", None)
    doc.setdefault("generation", 1)
    for u in units(doc):
        if isinstance(u.get("paragraphs"), list):
            u.setdefault("figures", [])
    for x in all_sentences(doc):
        x.setdefault("tags", [])
        x.setdefault("tag_notes", {})
    if isinstance(doc.get("slides"), list):
        slides.upgrade(doc)
    if doc.get("renderer") == "video":
        from . import video  # noqa: PLC0415

        doc["timing"] = video.timing(doc)
    return doc


def read_doc(c: str, inv_id: str, slug: str) -> dict[str, Any] | None:
    """The stored document of a type for an investigation; None until written."""
    doc = read_json(doc_file(c, inv_id, slug), None)
    if not isinstance(doc, dict):
        return None
    doc.setdefault("id", slug)
    doc.setdefault("type", slug)
    if slug == "report":
        doc.setdefault("renderer", "document")
        doc.setdefault("title_ok", _title_ok(_collapse(doc.get("title"))))
    elif slug == "slides":
        doc.setdefault("renderer", "slides")
    elif slug == LEGACY_VIDEO:
        doc.setdefault("renderer", "video")
    _legacy_comments(doc)
    return _with_defaults(doc)


# a legacy verify agent's marks, each read as the comment of the built-in check of its kind, a caveat as a judgment call
LEGACY_CHECKS = {"verified": "verified", "unverified": "unverified", "judgment": "judgment", "caveat": "judgment"}


def _legacy_comments(doc: dict[str, Any]) -> None:
    """A stored document's verifier comments as check comments, in place (LEGACY_CHECKS); written so on its next save."""
    from .report import CHECK_AUTHOR, LEGACY_AUTHOR  # noqa: PLC0415

    for cm in doc.get("comments") or []:
        if isinstance(cm, dict) and cm.get("author") == LEGACY_AUTHOR:
            cm["author"] = CHECK_AUTHOR
            cm["check"] = LEGACY_CHECKS.get(str(cm.pop("kind", "") or ""), "judgment")


def _inv(c: str, inv_id: str) -> Path:
    """The investigation's directory, `main` created on first touch."""
    return investigation.ensure_main(c) if inv_id == investigation.MAIN else investigation.inv_dir(c, inv_id)


_UNREAD: Any = object()  # write_doc's `before` when the caller has not read the document as it was


def docs_lock(c: str, inv_id: str = investigation.MAIN):
    """The lock of an investigation's documents (ledger.locked on its folder): held from a document's read to its write
    by a change that reads it first (comments.py), since more than one process can write documents in terminal mode."""
    return ledger.locked(_inv(c, inv_id))


def write_doc(c: str, inv_id: str, slug: str, doc: dict[str, Any], *, before: Any = _UNREAD) -> None:
    """Store a document under the documents' lock (docs_lock); a write that changes its text is an undo step
    (undo.doc_written) with the document as it was, read here unless the caller hands it over (`before`, None for
    none)."""
    path = _inv(c, inv_id) / f"{slug}.json"
    with docs_lock(c, inv_id):
        prior = read_json(path, None) if before is _UNREAD else before
        write_json(path, doc)
    undo.doc_written(c, inv_id, slug, "doc", prior if isinstance(prior, dict) else None, doc)


def _archive(c: str, inv_id: str, slug: str) -> Path | None:
    p = doc_file(c, inv_id, slug)
    if not p.is_file():
        return None
    hist = investigation.inv_dir(c, inv_id) / slug
    hist.mkdir(parents=True, exist_ok=True)
    dest = hist / f"{_stamp()}.json"
    os.replace(p, dest)
    return dest


def _load(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    doc = read_doc(c, inv_id, slug)
    if doc is None:
        raise HTTPException(404, f"no {slug} yet")
    return doc


def store(c: str, inv_id: str, slug: str, doc: dict[str, Any]) -> None:
    """Write a new generation, the previous one archived first (and kept as the undo step's document as it was)."""
    prior = read_json(doc_file(c, inv_id, slug), None)
    archived = _archive(c, inv_id, slug)
    if archived:
        log.info("%s: previous generation archived to %s", slug, archived)
    write_doc(c, inv_id, slug, doc, before=prior if isinstance(prior, dict) else None)


# --------------------------------------------------------------------------- shape adapters
# A document and a story have `sections`, a deck `slides`, a video `lines`, a custom document its own schema; a legacy
# story has `beats` and an `answer` until it is read (story.upgrade). A unit is a section, a slide or a beat, a heading
# with sentences, or a video's line, sentences without a heading.


def is_sentence(x: Any) -> bool:
    return isinstance(x, dict) and isinstance(x.get("text"), str) and isinstance(x.get("refs"), list) and isinstance(x.get("tags"), list)


def is_custom(doc: dict[str, Any]) -> bool:
    return doc.get("renderer") == "custom"


META_KEYS = {"id", "type", "renderer", "generation", "comments", "locked", "generated_at", "model", "model_requested", "effort",
             "cost_usd", "duration_s", "report_generation", "verified", "generation_failed", "title_history",
             "title_edited_by", "title_ok", "stages", "verifier", "params", "writer_tool_calls", "writer_tool_calls_capped",
             "words", "continuations", "format", "source", "snapshot", "what_changed", "instructions", "figures_made", "frame",
             "title_locked", "lock_reverts", "writer_run", "revision"}


def _walk_units(node: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(node, dict):
        if is_sentence(node):
            return
        if isinstance(node.get("heading"), str):
            out.append(node)
        for v in node.values():
            _walk_units(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk_units(v, out)


def _walk_sentences(node: Any, out: list[dict[str, Any]], *, stop_at_units: bool) -> None:
    if isinstance(node, dict):
        if is_sentence(node):
            out.append(node)
            return
        for v in node.values():
            if stop_at_units and isinstance(v, dict) and isinstance(v.get("heading"), str) and not is_sentence(v):
                continue
            _walk_sentences(v, out, stop_at_units=stop_at_units)
    elif isinstance(node, list):
        for v in node:
            if stop_at_units and isinstance(v, dict) and isinstance(v.get("heading"), str) and not is_sentence(v):
                continue
            _walk_sentences(v, out, stop_at_units=stop_at_units)


def units(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """The heading-bearing units of any shape, in document order."""
    if is_custom(doc):
        out: list[dict[str, Any]] = []
        for k, v in doc.items():
            if k not in META_KEYS:
                _walk_units(v, out)
        return out
    for key in ("beats", "slides", "sections", "lines"):
        if isinstance(doc.get(key), list):
            return [u for u in doc[key] if isinstance(u, dict)]
    return []


def unit_sentences(unit: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(unit.get("paragraphs"), list):
        return [x for p in unit["paragraphs"] if isinstance(p, dict)
                for x in (p.get("sentences") or []) if isinstance(x, dict)]
    if isinstance(unit.get("sentences"), list):
        return [x for x in unit["sentences"] if isinstance(x, dict)]
    out: list[dict[str, Any]] = []
    for k, v in unit.items():
        if k == "heading" or (isinstance(v, dict) and isinstance(v.get("heading"), str) and not is_sentence(v)):
            continue
        _walk_sentences(v, out, stop_at_units=True)
    return out


def all_sentences(doc: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if is_custom(doc):
        for k, v in doc.items():
            if k not in META_KEYS:
                _walk_sentences(v, out, stop_at_units=False)
        return out
    if isinstance(doc.get("answer"), dict):
        out.append(doc["answer"])
    for u in units(doc):
        out.extend(unit_sentences(u))
    return out


def _ids(doc: dict[str, Any]) -> set[str]:
    out: set[str] = set()
    if is_custom(doc):
        for n in _nodes({k: v for k, v in doc.items() if k not in META_KEYS}):
            if isinstance(n, dict) and isinstance(n.get("id"), str):
                out.add(n["id"])
    for x in all_sentences(doc):
        out.add(str(x.get("id")))
    for u in units(doc):
        out.add(str(u.get("id")))
        for p in u.get("paragraphs") or []:
            if isinstance(p, dict):
                out.add(str(p.get("id")))
        for f in u.get("figures") or []:
            if isinstance(f, dict):
                out.add(str(f.get("id")))
        g = u.get("graphic")
        if isinstance(g, dict) and g.get("id"):
            out.add(str(g["id"]))
    for cm in doc.get("comments") or []:
        out.add(str(cm.get("id")))
    return out


def find_target(doc: dict[str, Any], tid: str) -> dict[str, Any]:
    """{kind: sentence, unit, sentence} for a sentence id, {kind: heading, unit} for a unit id; 404 when neither."""
    if isinstance(doc.get("answer"), dict) and doc["answer"].get("id") == tid:
        return {"kind": "sentence", "unit": None, "sentence": doc["answer"]}
    for u in units(doc):
        for x in unit_sentences(u):
            if x.get("id") == tid:
                return {"kind": "sentence", "unit": u, "sentence": x}
    for u in units(doc):
        if u.get("id") == tid:
            return {"kind": "heading", "unit": u}
    for x in all_sentences(doc):
        if x.get("id") == tid:
            return {"kind": "sentence", "unit": None, "sentence": x}
    raise HTTPException(404, f"no such sentence or heading: {tid}")


def find_paragraph(doc: dict[str, Any], pid: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """(unit, paragraph) for a paragraph id of a document with paragraphs; None when none has it."""
    for u in units(doc):
        for p in u.get("paragraphs") or []:
            if isinstance(p, dict) and p.get("id") == pid:
                return u, p
    return None


def _find_comment(doc: dict[str, Any], cid: str) -> dict[str, Any]:
    for cm in doc.get("comments") or []:
        if cm.get("id") == cid:
            return cm
    raise HTTPException(404, f"no such comment: {cid}")


# --------------------------------------------------------------------------- the frame
# Before any write a document is a frame: the sections the analyst laid out, the figures they pinned and the bullets
# they wrote, every unit marked pinned and by the analyst. The same operations add pinned units to a written document.


def empty_frame(slug: str, t: dict[str, Any]) -> dict[str, Any]:
    """A frame with nothing in it: a deck's has slides, any other type's sections."""
    units_key = "slides" if t["renderer"] == "slides" else "sections"
    return {"id": slug, "type": slug, "renderer": t["renderer"], "title": "", units_key: [], "frame": True, "generation": 0}


def read_frame(c: str, inv_id: str, slug: str) -> dict[str, Any] | None:
    """The stored frame; a deck frame stored as sections reads as slides."""
    f = read_json(frame_file(c, inv_id, slug), None)
    if not isinstance(f, dict) or not (isinstance(f.get("sections"), list) or isinstance(f.get("slides"), list)):
        return None
    if f.get("renderer") == "slides" or isinstance(f.get("slides"), list):
        f = slides.upgrade(slides.frame_from_sections(f))
    elif f.get("renderer") == "story":
        from . import story  # noqa: PLC0415

        story.upgrade(f)
    return f


def write_frame(c: str, inv_id: str, slug: str, frame: dict[str, Any]) -> None:
    """Store the frame of a document not written yet; a write that changes its text is an undo step, as write_doc's."""
    path = _inv(c, inv_id) / f"{slug}.frame.json"
    prior = read_json(path, None)
    write_json(path, frame)
    undo.doc_written(c, inv_id, slug, "frame", prior if isinstance(prior, dict) else None, frame)


def frame_or_doc(c: str, inv_id: str, slug: str) -> tuple[dict[str, Any], bool]:
    """(the written document when there is one, else the frame, else an empty frame; whether it is the document)."""
    t = _require_type(c, slug)
    doc = read_doc(c, inv_id, slug)
    if doc is not None:
        return doc, True
    return read_frame(c, inv_id, slug) or empty_frame(slug, t), False


def _save_frame_or_doc(c: str, inv_id: str, slug: str, target: dict[str, Any], is_doc: bool) -> None:
    if is_doc:
        write_doc(c, inv_id, slug, target)
    else:
        write_frame(c, inv_id, slug, target)


def _pinned(rec: dict[str, Any], by: str) -> dict[str, Any]:
    rec["pinned"] = True
    rec["by"] = by
    return rec


def add_section(c: str, slug: str, heading: str, *, inv_id: str = investigation.MAIN, by: str = ANALYST) -> dict[str, Any]:
    """A pinned section with `heading` appended to the frame or the document; returns the section."""
    heading = _collapse(heading)
    if not heading:
        raise HTTPException(400, "heading is required")
    target, is_doc = frame_or_doc(c, inv_id, slug)
    key = "beats" if isinstance(target.get("beats"), list) else "slides" if isinstance(target.get("slides"), list) else "sections"
    sec: dict[str, Any] = {"id": _new_id(_ids(target)), "heading": heading}
    if key == "sections" and target.get("renderer") == "story":
        sec.update(card="right", paragraphs=[], figures=[])
    elif key == "sections":
        sec.update(role="custom", paragraphs=[], figures=[])
    elif key == "beats":
        sec.update(sentences=[], stakes="", figures=[])
    else:
        sec.update(sentences=[], figure=None, notes="")
    target.setdefault(key, []).append(_pinned(sec, by))
    _save_frame_or_doc(c, inv_id, slug, target, is_doc)
    return sec


def _unit_by_id(target: dict[str, Any], sid: str) -> dict[str, Any]:
    u = next((u for u in units(target) if str(u.get("id")) == sid), None)
    if u is None:
        raise HTTPException(404, f"no such section: {sid}")
    return u


def add_paragraph(c: str, slug: str, sid: str, text: str, *, inv_id: str = investigation.MAIN, by: str = ANALYST) -> dict[str, Any]:
    """A pinned paragraph of `text` appended to section `sid` of the frame or the document, not locked, since a lock is
    only the one the analyst sets (set_block_lock). Returns the paragraph, or the sentences added to a unit without
    paragraphs."""
    from . import report_format  # noqa: PLC0415

    if not _collapse(text):
        raise HTTPException(400, "text is required")
    target, is_doc = frame_or_doc(c, inv_id, slug)
    unit = _unit_by_id(target, sid)
    used = _ids(target)
    valid = _Refs(c)
    sentences = [_pinned(x, by) for x in report_format.sentence_units(text, valid, used)]
    if not sentences:
        raise HTTPException(400, "text is required")
    if isinstance(unit.get("paragraphs"), list):
        para = _pinned({"id": _new_id(used), "sentences": sentences}, by)
        unit["paragraphs"].append(para)
        out: dict[str, Any] = para
    else:
        unit.setdefault("sentences", []).extend(sentences)
        out = {"id": str(unit["id"]), "sentences": sentences, "pinned": True, "by": by}
    _save_frame_or_doc(c, inv_id, slug, target, is_doc)
    return out


def add_frame_figure(c: str, slug: str, sid: str, cell: str, caption: str | None = None, after: str | None = None, *,
                     inv_id: str = investigation.MAIN, by: str = ANALYST) -> dict[str, Any]:
    """A pinned figure showing `cell` appended to section `sid`, after paragraph `after` when given; returns it."""
    target, is_doc = frame_or_doc(c, inv_id, slug)
    unit = _unit_by_id(target, sid)
    cid = cite.strip_card(cell)
    valid = _Refs(c)
    if cid not in valid.cells:
        raise HTTPException(404, f"no such card: {cell}")
    pid = None
    if after:
        pid = str(after).strip().removeprefix("report:").split("#", 1)[-1].removeprefix("p")
        hit = find_paragraph(target, pid)
        if hit is None or hit[0] is not unit:
            raise HTTPException(404, f"no paragraph {after} in section {sid}")
    fig = _pinned({"id": _new_id(_ids(target)), "cell": f"card:{cid}", "caption": _collapse(caption) or valid.artifacts.get(cid) or "",
                   "after_paragraph": pid}, by)
    if target.get("renderer") == "story" and pid is None:
        from . import story  # noqa: PLC0415

        story.place_figure(unit, fig)
    elif isinstance(unit.get("figures"), list) or "figures" in unit or isinstance(unit.get("paragraphs"), list) or "sentences" in unit:
        unit.setdefault("figures", []).append(fig)
    _save_frame_or_doc(c, inv_id, slug, target, is_doc)
    return fig


def delete_unit(c: str, slug: str, uid: str, *, inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """Remove a pinned section, paragraph, sentence or figure of the frame or the document; returns what remains."""
    target, is_doc = frame_or_doc(c, inv_id, slug)
    key = "beats" if isinstance(target.get("beats"), list) else "slides" if isinstance(target.get("slides"), list) else "sections"
    found = False
    for u in list(units(target)):
        if str(u.get("id")) == uid:
            if is_doc and not u.get("pinned"):
                raise HTTPException(409, "only a unit the analyst pinned can be removed here")
            target[key] = [x for x in target.get(key) or [] if x is not u]
            found = True
            break
        for p in list(u.get("paragraphs") or []):
            if str(p.get("id")) == uid:
                if is_doc and not p.get("pinned"):
                    raise HTTPException(409, "only a unit the analyst pinned can be removed here")
                u["paragraphs"] = [x for x in u["paragraphs"] if x is not p]
                found = True
                break
        if found:
            break
        for f in list(u.get("figures") or []):
            if str(f.get("id")) == uid:
                if is_doc and not f.get("pinned"):
                    raise HTTPException(409, "only a unit the analyst pinned can be removed here")
                u["figures"] = [x for x in u["figures"] if x is not f]
                found = True
                break
        if found:
            break
        if isinstance(u.get("sentences"), list):
            hit = next((x for x in u["sentences"] if str(x.get("id")) == uid), None)
            if hit is not None:
                if is_doc and not hit.get("pinned"):
                    raise HTTPException(409, "only a unit the analyst pinned can be removed here")
                u["sentences"] = [x for x in u["sentences"] if x is not hit]
                found = True
                break
    if not found:
        raise HTTPException(404, f"no such unit: {uid}")
    _save_frame_or_doc(c, inv_id, slug, target, is_doc)
    return target


def edit_unit(c: str, slug: str, uid: str, *, text: str | None = None, heading: str | None = None, caption: str | None = None,
              inv_id: str = investigation.MAIN, by: str = ANALYST) -> dict[str, Any]:
    """The text of a pinned paragraph, the heading of a section or the caption of a figure changed, none of them locked
    by the edit (set_block_lock); returns the frame or the document."""
    from . import report_format  # noqa: PLC0415

    target, is_doc = frame_or_doc(c, inv_id, slug)
    changed = False
    for u in units(target):
        if str(u.get("id")) == uid and heading is not None:
            h = _collapse(heading)
            if not h:
                raise HTTPException(400, "heading is required")
            changed = _put_text(u, "heading", h, undo=True) or changed
            break
        para = next((p for p in u.get("paragraphs") or [] if str(p.get("id")) == uid), None)
        sent = next((x for x in unit_sentences(u) if str(x.get("id")) == uid), None)
        if (para is not None or sent is not None) and text is not None:
            t = _collapse(text)
            if not t:
                raise HTTPException(400, "text is required")
            used = _ids(target)
            valid = _Refs(c)
            new = [_pinned(x, by) for x in report_format.sentence_units(t, valid, used)]
            if para is not None:
                para["sentences"] = new
            else:
                assert sent is not None
                if isinstance(u.get("sentences"), list):
                    i = next(i for i, x in enumerate(u["sentences"]) if x is sent)
                    u["sentences"][i:i + 1] = new
                else:
                    hit = next((p for p in u.get("paragraphs") or [] if any(x is sent for x in p.get("sentences") or [])), None)
                    if hit is not None:
                        i = next(i for i, x in enumerate(hit["sentences"]) if x is sent)
                        hit["sentences"][i:i + 1] = new
            changed = True
            break
        fig = next((f for f in u.get("figures") or [] if str(f.get("id")) == uid), None)
        if fig is not None and caption is not None:
            cap = _collapse(caption)
            if not cap:
                raise HTTPException(400, "caption is required")
            fig["caption"] = cap
            changed = True
            break
    else:
        raise HTTPException(404, f"no such unit: {uid}")
    if changed:
        _save_frame_or_doc(c, inv_id, slug, target, is_doc)
    return target


def pinned_figures(*docs: dict[str, Any] | None) -> list[tuple[int, str, dict[str, Any]]]:
    """[(section index, heading, figure)] of every pinned figure in the given documents or frames, each cell once."""
    out: list[tuple[int, str, dict[str, Any]]] = []
    seen: set[str] = set()
    for d in docs:
        if not d:
            continue
        for i, u in enumerate(units(d)):
            for f in u.get("figures") or []:
                if isinstance(f, dict) and f.get("pinned") and f.get("cell") and cite.canon(str(f["cell"])) not in seen:
                    seen.add(cite.canon(str(f["cell"])))
                    out.append((i, _collapse(u.get("heading")), f))
    return out


def place_pinned(doc: dict[str, Any], pinned: list[tuple[int, str, dict[str, Any]]]) -> int:
    """Every pinned figure kept in the new generation: one the writer placed keeps its mark, one it left out goes into
    the section whose heading matches best, else the section at its old index, else the first. Returns how many were
    re-inserted."""
    from . import report_format  # noqa: PLC0415

    us = units(doc)
    if not us or not pinned:
        return 0
    used = _ids(doc)
    have: dict[str, dict[str, Any]] = {}
    for u in us:
        for f in u.get("figures") or []:
            if isinstance(f, dict) and f.get("cell"):
                have.setdefault(cite.canon(str(f["cell"])), f)
    inserted = 0
    for index, heading, fig in pinned:
        cell = cite.canon(str(fig["cell"]))
        if cell in have:
            have[cell]["pinned"] = True
            have[cell]["by"] = fig.get("by") or ANALYST
            continue
        want = report_format.tokens(heading)
        best, score = None, 0.0
        for u in us:
            toks = report_format.tokens(u.get("heading"))
            s = len(want & toks) / len(want) if want and toks else 0.0
            if s > score:
                best, score = u, s
        target = best if best is not None and score >= 0.5 else us[min(index, len(us) - 1)]
        rec = {"id": _new_id(used), "cell": cell, "caption": fig.get("caption") or "", "after_paragraph": None,
               "pinned": True, "by": fig.get("by") or ANALYST}
        if doc.get("renderer") == "story":
            from . import story  # noqa: PLC0415

            story.place_figure(target, rec)
        else:
            target.setdefault("figures", []).append(rec)
        inserted += 1
    return inserted


# --------------------------------------------------------------------------- normalization


def clean_sentence(x: Any, valid: _Refs, used: set[str]) -> dict[str, Any] | None:
    """A sentence record from a sentence object or a bare string, refs validated; None when empty."""
    if isinstance(x, str):
        x = {"text": x}
    if not isinstance(x, dict):
        return None
    text = _collapse(x.get("text"))
    if not text:
        return None
    listed = {str(t).strip().lower() for t in x["tags"] if isinstance(t, str)} if isinstance(x.get("tags"), list) else set()
    tags = [t for t in TAGS if t in listed]
    raw_notes = x.get("tag_notes") if isinstance(x.get("tag_notes"), dict) else {}
    notes = {str(k).strip().lower(): _collapse(v) for k, v in raw_notes.items()
             if str(k).strip().lower() in tags and isinstance(v, str) and v.strip()}
    return {"id": _new_id(used), "text": text, "refs": valid.clean(x.get("refs"), text), "tags": tags,
            "tag_notes": {t: notes[t] for t in tags if t in notes}}


def _normalize_document(raw: dict[str, Any], valid: _Refs, slug: str) -> dict[str, Any]:
    """A custom document-renderer type's document from the `document` tool's input, every section of role custom. Text
    before
    the first `## ` is the document's opening and keeps no heading, as the report's does."""
    from . import report_format  # noqa: PLC0415

    used: set[str] = set()
    sections: list[dict[str, Any]] = []
    raw_secs = [s for s in raw["sections"] if isinstance(s, dict)] if isinstance(raw.get("sections"), list) else []
    for i, s in enumerate(raw_secs):
        heading = _collapse(s.get("heading"))
        paragraphs: list[dict[str, Any]] = []
        if isinstance(s.get("body"), (str, list)):
            for para in report_format.segment_units(s["body"] if isinstance(s["body"], str)
                                                     else "\n\n".join(str(b) for b in s["body"] if isinstance(b, str))):
                paragraphs.append({"id": _new_id(used), "sentences": report_format.records_of(para, valid, used)})
        for p in s.get("paragraphs") if isinstance(s.get("paragraphs"), list) else []:
            items = p.get("sentences") if isinstance(p, dict) else p
            sentences = [y for y in (clean_sentence(x, valid, used) for x in (items or [])) if y]
            if sentences:
                paragraphs.append({"id": _new_id(used), "sentences": sentences})
        if (not paragraphs and not over_subheading(raw_secs, i)) or (not heading and sections):
            continue
        para_ids = [str(p["id"]) for p in paragraphs]
        sections.append({"id": _new_id(used), "role": "custom", "heading": heading, "paragraphs": paragraphs,
                         "figures": report_format.figures(s.get("figures"), valid, para_ids, used),
                         **({"level": _level(s.get("level"))} if _level(s.get("level")) > 2 else {})})
    if not sections:
        raise HTTPException(502, "the model returned no section with a sentence")
    title = _collapse(raw.get("title")) or slug
    return {"id": slug, "type": slug, "renderer": "document", "title": title, "title_ok": _title_ok(title), "sections": sections}


def normalize(t: dict[str, Any], raw: dict[str, Any], valid: _Refs) -> dict[str, Any]:
    """The stored document from the shape parse_markdown gives, by the type's form. 400 when nothing survives."""
    from . import report, story  # noqa: PLC0415

    slug = t["slug"]
    try:
        if slug == "report":
            doc = report._normalize(raw, valid)
            doc.update(type="report", renderer="document")
            return doc
        if t["renderer"] == "document":
            return _normalize_document(raw, valid, slug)
        if t["renderer"] == "slides":
            doc = slides.normalize(raw, valid)
            doc.update(id=slug, type=slug, renderer="slides")
            return doc
        if t["renderer"] == "story":
            return story.normalize_outline(raw, valid, slug)
        if t["renderer"] == "video":
            from . import video  # noqa: PLC0415

            return video.normalize(t, raw, valid)
        if t.get("page"):
            return _normalize_page(t, raw, valid)
    except HTTPException as e:
        raise HTTPException(400, str(e.detail)) from e
    raise HTTPException(400, f"the {slug} has a form of its own, which is not written from markdown")


def _normalize_page(t: dict[str, Any], raw: dict[str, Any], valid: _Refs) -> dict[str, Any]:
    """A page from {title, html, claims}: the html as written and every claim as sentence records."""
    from . import report_format  # noqa: PLC0415

    html = str(raw.get("html") or "").strip()
    if not html:
        raise HTTPException(400, "the page has no html block")
    if len(html) > HTML_MAX:
        raise HTTPException(400, f"the page's html is longer than {HTML_MAX} characters")
    used: set[str] = set()
    claims = [x for c in raw.get("claims") or [] for x in report_format.sentence_units(str(c), valid, used)]
    if not claims:
        raise HTTPException(400, "the page states no claim")
    return {"id": t["slug"], "type": t["slug"], "renderer": "custom", "title": _collapse(raw.get("title")) or t.get("name") or t["slug"],
            "html": html, "claims": claims}


# --------------------------------------------------------------------------- the analyst's locks on blocks
# A locked block stays fixed in every later revision and no model can overwrite it. The analyst locks a block (the
# title, a heading, a paragraph or list, a figure) with set_block_lock, which sets `locked: true` on its record
# (`title_locked` for the title). The writer is told (locked_block_lines, read_ref marks, edit_document refusals via
# locked_block_ref), and after every model save each locked block is put back exactly as it was and where it stood
# (keep_locked_blocks via hold_locks); each block the save changed is recorded in `lock_reverts`.

TITLE_BLOCK = "title"  # the title block's id in the editor (frontend/src/report/model.ts TITLE_ID)
LOCK_MATCH = 0.5  # the word overlap (shared over all) at which a writer's paragraph reads as its rewrite of a locked one
LOCK_WITHIN = 0.75  # or the share of a writer's paragraph's words the locked one holds, for a shortened rewrite
LOCK_WITHIN_WORDS = 4  # the fewest content words a paragraph needs before LOCK_WITHIN reads it as a rewrite
# the word overlap at which a paragraph where the locked one stood (its index, or one either side) reads as its rewrite:
# a paraphrase shares nouns more than wording
LOCK_NEAR = 0.3


def _para_key(p: dict[str, Any]) -> str:
    return sentence_key(" ".join(str(x.get("text") or "") for x in p.get("sentences") or [] if isinstance(x, dict)))


def _overlap(locked: str, text: str) -> float:
    """How much `text` reads as a rewrite of the locked paragraph `locked`: their word overlap, or 0 when it is below
    LOCK_MATCH and the locked paragraph does not hold most of `text`'s words (LOCK_WITHIN)."""
    from . import report_format  # noqa: PLC0415

    ta, tb = report_format.tokens(locked), report_format.tokens(text)
    if not ta or not tb:
        return 0.0
    shared = len(ta & tb)
    score = shared / len(ta | tb)
    within = len(tb) >= LOCK_WITHIN_WORDS and shared / len(tb) >= LOCK_WITHIN
    return score if score >= LOCK_MATCH or within else 0.0


def lock_target(target: dict[str, Any], bid: str) -> tuple[str, dict[str, Any] | None]:
    """(kind, record) of the editor's block `bid`: (title, None) for the title, (heading, section) for a section's id,
    (paragraph, paragraph) for a paragraph's id or a sentence's in it, since each item of a list is a block of its own
    and the list is one paragraph, and (figure, figure) for a figure's id. 404 for any other id."""
    if bid == TITLE_BLOCK:
        return "title", None
    for u in units(target):
        if str(u.get("id")) == bid:
            return "heading", u
        for p in u.get("paragraphs") or []:
            if isinstance(p, dict) and (str(p.get("id")) == bid
                                        or any(str(x.get("id")) == bid for x in p.get("sentences") or [] if isinstance(x, dict))):
                return "paragraph", p
        for f in u.get("figures") or []:
            if isinstance(f, dict) and str(f.get("id")) == bid:
                return "figure", f
    raise HTTPException(404, f"no block {bid}")


def block_ref(slug: str, kind: str, rec: dict[str, Any] | None) -> str:
    """A locked block's ref as read_ref's lines give it (a paragraph's with its p); the title's is `report:<slug>#title`."""
    if kind == "title" or rec is None:
        return f"report:{slug}#{TITLE_BLOCK}"
    return f"report:{slug}#{'p' if kind == 'paragraph' else ''}{rec.get('id')}"


def set_block_lock(c: str, inv_id: str, slug: str, bid: str, locked: bool) -> dict[str, Any]:
    """The analyst's lock on the block `bid` set or cleared, in the written document or else the frame, and a `lock` or
    `unlock` row of the telemetry when it changed. Returns the document or the frame. 409 for a type the editor does
    not show (a deck, a page), 404 for a block it does not have."""
    from . import telemetry  # noqa: PLC0415

    if _require_type(c, slug)["renderer"] not in ("document", "story"):
        raise HTTPException(409, "only the blocks of a document with sections are locked")
    target, is_doc = frame_or_doc(c, inv_id, slug)
    kind, rec = lock_target(target, bid)
    holder = target if rec is None else rec
    key = "title_locked" if rec is None else "locked"
    if (holder.get(key) is True) != locked:
        if locked:
            holder[key] = True
        else:
            holder.pop(key, None)
        _save_frame_or_doc(c, inv_id, slug, target, is_doc)
        telemetry.note(c, "lock" if locked else "unlock", block_ref(slug, kind, rec))
    return target


def locked_block_ref(doc: dict[str, Any], slug: str, uid: str, *, whole: bool = False) -> str | None:
    """The ref of the locked block that holds the passage `uid` names (a sentence, a paragraph, a heading or a figure),
    None when that block is not locked: edit_document's check. With `whole` (a delete), a section's id names the
    section with all it holds, so a locked block inside it counts too."""
    for u in units(doc):
        if str(u.get("id")) == uid:
            if u.get("locked") is True:
                return block_ref(slug, "heading", u)
            inside = [block_ref(slug, "paragraph", p) for p in u.get("paragraphs") or [] if isinstance(p, dict) and p.get("locked") is True]
            inside += [block_ref(slug, "figure", f) for f in u.get("figures") or [] if isinstance(f, dict) and f.get("locked") is True]
            return inside[0] if whole and inside else None
        for p in u.get("paragraphs") or []:
            if isinstance(p, dict) and (str(p.get("id")) == uid
                                        or any(str(x.get("id")) == uid for x in p.get("sentences") or [] if isinstance(x, dict))):
                return block_ref(slug, "paragraph", p) if p.get("locked") is True else None
        for f in u.get("figures") or []:
            if isinstance(f, dict) and str(f.get("id")) == uid:
                return block_ref(slug, "figure", f) if f.get("locked") is True else None
    return None


def locked_sentence_ids(doc: dict[str, Any]) -> set[str]:
    """The ids of the sentences in locked paragraphs, which the citation check of a save leaves as they are."""
    return {str(x.get("id")) for u in units(doc) for p in u.get("paragraphs") or []
            if isinstance(p, dict) and p.get("locked") is True for x in p.get("sentences") or [] if isinstance(x, dict)}


def locked_refs(doc: dict[str, Any], slug: str) -> list[str]:
    """The refs of every locked block of a document or a frame, in document order."""
    out = [block_ref(slug, "title", None)] if doc.get("title_locked") is True else []
    for u in units(doc):
        if u.get("locked") is True:
            out.append(block_ref(slug, "heading", u))
        out += [block_ref(slug, "paragraph", p) for p in u.get("paragraphs") or [] if isinstance(p, dict) and p.get("locked") is True]
        out += [block_ref(slug, "figure", f) for f in u.get("figures") or [] if isinstance(f, dict) and f.get("locked") is True]
    return out


def locked_blocks(prev: dict[str, Any] | None) -> dict[str, Any]:
    """What the analyst locked in `prev`, a document or a frame, for keep_locked_blocks: the title when locked, every
    section's
    heading, and for each section holding a lock its position, id, heading, role and locked paragraphs and figures
    with
    their neighbours."""
    snap: dict[str, Any] = {"title": None, "headings": [], "sections": []}
    if not prev:
        return snap
    if prev.get("title_locked") is True and _collapse(prev.get("title")):  # a locked empty title would blank the writer's
        snap["title"] = str(prev.get("title") or "")
    for i, u in enumerate(units(prev)):
        snap["headings"].append(_collapse(u.get("heading")))
        paras = [p for p in u.get("paragraphs") or [] if isinstance(p, dict)]
        at = {str(p.get("id")): j for j, p in enumerate(paras)}
        lp = [{"index": j, "record": copy.deepcopy(p), "before_key": _para_key(paras[j - 1]) if j > 0 else None,
               "after_key": _para_key(paras[j + 1]) if j + 1 < len(paras) else None}
              for j, p in enumerate(paras) if p.get("locked") is True]
        lf = []
        for f in u.get("figures") or []:
            if isinstance(f, dict) and f.get("locked") is True:
                j = at.get(str(f.get("after_paragraph") or ""))
                lf.append({"record": copy.deepcopy(f), "after_index": j, "after_key": _para_key(paras[j]) if j is not None else None})
        if u.get("locked") is True or lp or lf:
            snap["sections"].append({"index": i, "id": str(u.get("id")), "heading": str(u.get("heading") or ""),
                                     "role": u.get("role") or "custom", "heading_locked": u.get("locked") is True,
                                     "paragraphs": lp, "figures": lf})
    return snap


def _drop_paragraph(sec: dict[str, Any], p: dict[str, Any]) -> None:
    """Paragraph `p` taken out of `sec`, the figures after it moved after the paragraph before it (to the top when
    there is none)."""
    paras = sec["paragraphs"]
    i = next(k for k, x in enumerate(paras) if x is p)
    before = paras[i - 1] if i > 0 else None
    del paras[i]
    for f in sec.get("figures") or []:
        if isinstance(f, dict) and str(f.get("after_paragraph") or "") == str(p.get("id")):
            f["after_paragraph"] = before["id"] if before is not None else None
            if before is None:
                f["lead"] = True


def _free_ids(rec: dict[str, Any], used: set[str]) -> None:
    """The ids of a record taken out of the document (its own and its sentences') free again, so the locked record
    that takes its place keeps its own ids when they were the same (a save that edited the document in place)."""
    for node in [rec, *(x for x in rec.get("sentences") or [] if isinstance(x, dict))]:
        used.discard(str(node.get("id") or ""))


def _own_ids(rec: dict[str, Any], used: set[str]) -> None:
    """A restored record's ids (its own and its sentences') kept, save one the new generation already gave another
    record, which gets a fresh id; every id ends in `used`."""
    for node in [rec, *(x for x in rec.get("sentences") or [] if isinstance(x, dict))]:
        i = str(node.get("id") or "")
        if not i or i in used:
            node["id"] = _new_id(used)
        else:
            used.add(i)


def keep_locked_blocks(doc: dict[str, Any], snap: dict[str, Any], slug: str) -> list[tuple[str, bool]]:
    """Every block the analyst locked back in `doc` exactly as it was and where it stood, whatever a model's save wrote.
    A
    locked block's section is found by id, heading, or index (a renamed section), else recreated. A locked paragraph
    replaces the model's copy of it, or its split copies, or the paragraph that reads most as its rewrite (_overlap,
    LOCK_NEAR), else goes back at its index; a locked figure goes after the paragraph it followed. Mutates `doc`;
    returns
    (ref, changed) per locked block."""
    kept: list[tuple[str, bool]] = []
    if snap.get("title") is not None:
        kept.append((block_ref(slug, "title", None), doc.get("title") != snap["title"]))
        doc["title"] = snap["title"]
        doc["title_locked"] = True
    sections = doc.get("sections")
    if not snap.get("sections") or not isinstance(sections, list):
        return kept
    for u in sections:  # a save that edited the document in place holds the locked records: they read as its copies
        if isinstance(u, dict):
            u.pop("locked", None)
            for rec in [*(u.get("paragraphs") or []), *(u.get("figures") or [])]:
                if isinstance(rec, dict):
                    rec.pop("locked", None)
    used = _ids(doc)
    old_headings = set(snap.get("headings") or [])
    claimed: set[int] = set()

    def unlocked(q: Any) -> bool:
        return isinstance(q, dict) and q.get("locked") is not True

    def best_match(paras: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
        scored = [(_overlap(key, _para_key(q)), q) for q in paras if unlocked(q)]
        score, hit = max(scored, key=lambda s: s[0], default=(0.0, None))
        return hit if score > 0 else None

    def near_match(paras: list[Any], key: str, index: int) -> dict[str, Any] | None:
        """The paragraph within one of `index` whose words overlap the locked one's most, from LOCK_NEAR."""
        from . import report_format  # noqa: PLC0415

        ta = report_format.tokens(key)
        best: tuple[float, dict[str, Any]] | None = None
        for q in paras[max(0, index - 1): index + 2]:
            tb = report_format.tokens(_para_key(q)) if unlocked(q) else set()
            score = len(ta & tb) / len(ta | tb) if ta and tb else 0.0
            if score >= LOCK_NEAR and (best is None or score > best[0]):
                best = (score, q)
        return best[1] if best else None

    def texts_of(p: dict[str, Any]) -> list[Any]:
        return [x.get("text") for x in p.get("sentences") or [] if isinstance(x, dict)]

    def index_of(rows: list[Any], rec: Any) -> int:
        return next(k for k, q in enumerate(rows) if q is rec)

    def take_copies(target: dict[str, Any], lkeys: set[str]) -> tuple[dict[str, Any], int] | None:
        """Take each sentence of a locked paragraph (`lkeys`) that the save copied into another paragraph out of it.
        Returns where
        the locked paragraph goes back beside the paragraph of `target` that held the most copies: (paragraph, 0)
        before,
        (paragraph, 1) in its place, (paragraph, 2) after. None when `target` held no copy."""
        found = []
        for s in sections:
            for q in s.get("paragraphs") or []:
                if unlocked(q):
                    sents = [x for x in q.get("sentences") or [] if isinstance(x, dict)]
                    hits = [k for k, x in enumerate(sents) if sentence_key(x.get("text")) in lkeys]
                    if hits:
                        found.append((s, q, sents, hits))
        best = max((f for f in found if f[0] is target), key=lambda f: len(f[3]), default=None)
        place = None
        for s, q, sents, hits in found:
            for k in hits:
                used.discard(str(sents[k].get("id") or ""))
            head = sents[:hits[0]]
            tail = [x for k, x in enumerate(sents) if k > hits[0] and k not in hits]
            if best is None or q is not best[1]:
                q["sentences"] = head + tail
                if not q["sentences"]:
                    _drop_paragraph(s, q)
                    used.discard(str(q.get("id") or ""))
                continue
            q["sentences"] = head or tail
            place = (q, 2 if head else 0 if tail else 1)
            if head and tail:
                rest = {"id": _new_id(used), "sentences": tail}
                s["paragraphs"].insert(index_of(s["paragraphs"], q) + 1, rest)
                for f in s.get("figures") or []:  # a figure after the whole paragraph stays after all of it
                    if isinstance(f, dict) and str(f.get("after_paragraph") or "") == str(q.get("id")):
                        f["after_paragraph"] = rest["id"]
        return place

    def beside(target: dict[str, Any], rec: dict[str, Any], p: dict[str, Any]) -> bool:
        """The restored paragraph moved back beside the paragraph that stood before (or after) it, when the save kept
        that one word for word and put it on the other side; True when it moved."""
        paras = target["paragraphs"]
        me = index_of(paras, rec)
        for key, after in ((p.get("before_key"), True), (p.get("after_key"), False)):
            k = next((k for k, q in enumerate(paras) if key and unlocked(q) and _para_key(q) == key), None)
            if k is None or (k < me if after else k > me):
                continue
            paras.pop(me)
            k = next(j for j, q in enumerate(paras) if unlocked(q) and _para_key(q) == key)
            paras.insert(k + 1 if after else k, rec)
            return True
        return False

    for item in snap["sections"]:
        heading = _collapse(item["heading"])
        # by its id first, which only a document edited in place keeps (a new generation's ids are all new), then by
        # its heading
        target = next((s for s in sections if isinstance(s, dict) and id(s) not in claimed and str(s.get("id")) == item["id"]), None)
        target = target or next((s for s in sections if isinstance(s, dict) and id(s) not in claimed and heading
                                 and _collapse(s.get("heading")) == heading), None)
        heading_changed = target is None or _collapse(target.get("heading")) != heading
        if target is None:
            at = min(item["index"], len(sections) - 1)
            cand = sections[at] if sections else None
            if cand is not None and id(cand) not in claimed and _collapse(cand.get("heading")) not in old_headings:
                target = cand  # the writer renamed the section
            else:
                target = {"id": _new_id(used), "heading": item["heading"], "role": item.get("role") or "custom",
                          "paragraphs": [], "figures": []}
                sections.insert(min(item["index"], len(sections)), target)
        if item["id"] not in used:  # the previous id, so the editor's block and its lock stay the same
            used.discard(str(target.get("id")))
            target["id"] = item["id"]
            used.add(item["id"])
        claimed.add(id(target))
        target.setdefault("paragraphs", [])
        target.setdefault("figures", [])
        if item["heading_locked"]:
            target["heading"] = item["heading"]
            target["locked"] = True
            kept.append((block_ref(slug, "heading", target), heading_changed))
        for p in sorted(item["paragraphs"], key=lambda x: x["index"]):
            rec = copy.deepcopy(p["record"])
            key = _para_key(rec)
            copies = [(s, q) for s in sections for q in list(s.get("paragraphs") or []) if unlocked(q) and _para_key(q) == key]
            mine = [q for s, q in copies if s is target]
            # a save that edited the document in place holds the locked paragraph itself, by its id, among its copies;
            # another copy there is the model's own text, which stays, as a new generation's second copy does not
            spot = next((q for q in mine if str(q.get("id")) == str(rec.get("id"))), None)
            if spot is None:
                spot = mine[0] if mine else None
                for s, q in copies:
                    if q is not spot:
                        _drop_paragraph(s, q)
                        _free_ids(q, used)
            changed = spot is None or texts_of(spot) != texts_of(rec)
            place = None if spot is not None else take_copies(target, {k for k in map(sentence_key, texts_of(rec)) if k})
            if place is not None and place[1] == 1:
                spot = place[0]
            elif spot is None and place is None:
                spot = (best_match([q for q in target["paragraphs"] if isinstance(q, dict)], key)
                        or near_match(target["paragraphs"], key, p["index"]))
            if spot is not None:
                _free_ids(spot, used)
                _own_ids(rec, used)
                target["paragraphs"][index_of(target["paragraphs"], spot)] = rec
                for f in target["figures"]:
                    if isinstance(f, dict) and str(f.get("after_paragraph") or "") == str(spot.get("id")):
                        f["after_paragraph"] = rec["id"]
            else:
                _own_ids(rec, used)
                at = (index_of(target["paragraphs"], place[0]) + (1 if place[1] == 2 else 0) if place is not None
                      else min(p["index"], len(target["paragraphs"])))
                target["paragraphs"].insert(at, rec)
            if beside(target, rec, p):
                changed = True
            kept.append((block_ref(slug, "paragraph", rec), changed))
        for fi in item["figures"]:
            rec = copy.deepcopy(fi["record"])
            card = cite.canon(str(rec.get("cell") or ""))
            copies = [f for f in target["figures"] if unlocked(f) and cite.canon(str(f.get("cell") or "")) == card]
            changed = not any(_collapse(f.get("caption")) == _collapse(rec.get("caption")) for f in copies)
            spot_fig = next((f for f in copies if str(f.get("id")) == str(rec.get("id"))), None)
            if spot_fig is None:  # as for a paragraph: only a new generation's other copies of the card go
                spot_fig = copies[0] if copies else None
                for s in sections:
                    keep = []
                    for f in s.get("figures") or []:
                        if f is not spot_fig and unlocked(f) and cite.canon(str(f.get("cell") or "")) == card:
                            used.discard(str(f.get("id") or ""))
                        else:
                            keep.append(f)
                    s["figures"] = keep
            paras = [q for q in target["paragraphs"] if isinstance(q, dict)]
            after = None
            if fi["after_index"] is not None and paras:
                old = str(rec.get("after_paragraph") or "")
                # by its id: a locked paragraph put back, or any paragraph of a document edited in place
                after = (next((q for q in paras if str(q.get("id")) == old), None)
                         or next((q for q in paras if _para_key(q) == fi["after_key"]), None)
                         or best_match(paras, fi["after_key"] or "")
                         or paras[min(fi["after_index"], len(paras) - 1)])
            rec["after_paragraph"] = str(after["id"]) if after is not None else None
            if spot_fig is not None:
                used.discard(str(spot_fig.get("id") or ""))
                _own_ids(rec, used)
                target["figures"][index_of(target["figures"], spot_fig)] = rec
            else:
                _own_ids(rec, used)
                target["figures"].append(rec)
            kept.append((block_ref(slug, "figure", rec), changed))
    return kept


LOCK_REVERT_CHARS = 160  # of a reverted block's text in its `lock_reverts` entry, for the Report tab's note


def _block_text(doc: dict[str, Any], ref: str) -> str:
    """The text a locked block shows as the reader sees it (the title, a heading, a paragraph, a figure's caption), by
    its ref (block_ref)."""
    bid = ref.split("#", 1)[-1]
    if bid == TITLE_BLOCK:
        return _collapse(doc.get("title"))
    for u in units(doc):
        if str(u.get("id")) == bid:
            return _collapse(u.get("heading"))
        for p in u.get("paragraphs") or []:
            if isinstance(p, dict) and f"p{p.get('id')}" == bid:
                return plain_text(" ".join(str(x.get("text") or "") for x in p.get("sentences") or [] if isinstance(x, dict)))
        for f in u.get("figures") or []:
            if isinstance(f, dict) and str(f.get("id")) == bid:
                return _collapse(f.get("caption")) or cite.canon(str(f.get("cell") or ""))
    return ""


def current_reverts(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The document's `lock_reverts` entries of its current generation: the locked blocks a model's save changed and
    thimble put back since this generation was written."""
    gen = int((doc or {}).get("generation") or 1)
    return [r for r in (doc or {}).get("lock_reverts") or [] if isinstance(r, dict) and int(r.get("generation") or 0) == gen]


def hold_locks(c: str, inv_id: str, slug: str, doc: dict[str, Any], before: dict[str, Any] | None, *, tool: str,
               by: str) -> list[str]:
    """After a model's save, every block the analyst locked in `before` back in `doc` as it was (keep_locked_blocks).
    Each
    block the save did not hold is a `lock-refused` telemetry row and a `lock_reverts` entry {ref, text, generation,
    tool,
    by, ts} for the current generation. Mutates `doc`; returns the refs put back."""
    from . import telemetry  # noqa: PLC0415

    reverted = [ref for ref, changed in keep_locked_blocks(doc, locked_blocks(before), slug) if changed]
    gen = int(doc.get("generation") or 1)
    entries = [r for r in current_reverts(doc) if r.get("ref") not in reverted]
    for ref in reverted:
        entries.append({"ref": ref, "text": _cut(_block_text(doc, ref), LOCK_REVERT_CHARS), "generation": gen, "tool": tool,
                        "by": by, "ts": _now()})
        if inv_id == investigation.MAIN:
            telemetry.note(c, "lock-refused", ref, actor="model", detail={"tool": tool})
    if entries:
        doc["lock_reverts"] = entries
    else:
        doc.pop("lock_reverts", None)
    return reverted


def locked_block_lines(doc: dict[str, Any]) -> list[str]:
    """The blocks the analyst locked in a document or a frame, in read_ref's notation, with enough surrounding structure
    for
    the writer to see where each stands. Empty when nothing is locked."""
    lines: list[str] = []
    if doc.get("title_locked") is True:
        lines.append(f"# {doc.get('title') or ''} · locked")
    for u in units(doc):
        paras = [p for p in u.get("paragraphs") or [] if isinstance(p, dict)]
        figs = [f for f in u.get("figures") or [] if isinstance(f, dict) and f.get("locked") is True]
        if u.get("locked") is not True and not figs and not any(p.get("locked") is True for p in paras):
            continue
        lines.append(f"{_marks_of(u)} {u.get('heading') or '(no heading)'} · #{u.get('id')}" + (" · locked" if u.get("locked") is True else ""))
        known = {str(p.get("id")) for p in paras}
        lines += [_figure_line(f) for f in figs if str(f.get("after_paragraph") or "") not in known]
        for p in paras:
            if p.get("locked") is True:
                lines.append(f"¶ #p{p.get('id')} · locked")
                lines += _sentence_lines(p.get("sentences") or [], "  ")
            else:
                lines.append(f"¶ #p{p.get('id')}")
            lines += [_figure_line(f) for f in figs if str(f.get("after_paragraph") or "") == str(p.get("id"))]
    return lines


def carry_comments(prev: dict[str, Any] | None, doc: dict[str, Any], generation: int = 0) -> list[dict[str, Any]]:
    """The previous generation's comments on the new one, each re-pointed at the sentence or heading whose text
    survived verbatim; the rest keep their old id and the text they were on, and settle by settle_carried_comment."""
    out: list[dict[str, Any]] = []
    if not prev:
        return out
    by_text: dict[str, str] = {}
    for x in all_sentences(doc):
        by_text.setdefault(f"s:{x.get('text') or ''}", str(x["id"]))
    for u in units(doc):
        if "heading" in u:
            by_text.setdefault(f"h:{u.get('heading') or ''}", str(u["id"]))
    for cm in prev.get("comments") or []:
        if not isinstance(cm, dict):
            continue
        cm = dict(cm)
        anchored = False
        try:
            t = find_target(prev, str(cm.get("sentence_id")))
            was_on = str(t["sentence"].get("text") or "") if t["kind"] == "sentence" else str(t["unit"].get("heading") or "")
            key = f"s:{was_on}" if t["kind"] == "sentence" else f"h:{was_on}"
            cm.setdefault("was_on", was_on)
            if key in by_text:
                cm["sentence_id"] = by_text[key]
                anchored = True
        except HTTPException:
            pass
        out.append(settle_carried_comment(cm, anchored=anchored, generation=generation))
    return out


def open_comments(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [cm for cm in (doc or {}).get("comments") or [] if isinstance(cm, dict) and (cm.get("status") or "open") == "open"]


def anchor_ids(doc: dict[str, Any] | None) -> set[str]:
    d = doc or {}
    return {str(x.get("id")) for x in all_sentences(d)} | {str(u.get("id")) for u in units(d)}


def anchored_open_comments(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The open comments whose anchor is in the text as it stands."""
    ids = anchor_ids(doc)
    return [cm for cm in open_comments(doc) if str(cm.get("sentence_id")) in ids]


def finish_generation(c: str, inv_id: str, slug: str, doc: dict[str, Any], *, request: str | None = None,
                      frame: dict[str, Any] | None = None, refused: list[str] | None = None,
                      by: str = "model", same_run: bool = False) -> dict[str, Any]:
    """The new generation numbered, the locked blocks put back (hold_locks), the previous generation's comments and
    pinned
    figures carried onto it, and the snapshot for the next diff taken; refs of locked blocks the text changed go into
    `refused`. With `same_run` it keeps the current generation's number and lock notes. Mutates and returns `doc`."""
    from . import revise_diff  # noqa: PLC0415

    prev = read_doc(c, inv_id, slug)
    if same_run and prev:
        doc["generation"] = int(prev.get("generation") or 1)
        doc["revision"] = int(prev.get("revision") or 1) + 1
        if current_reverts(prev):
            doc["lock_reverts"] = current_reverts(prev)
        if request is None and prev.get("instructions"):
            doc["instructions"] = prev["instructions"]
    else:
        doc["generation"] = (int(prev.get("generation") or 1) + 1) if prev else 1
    reverted = hold_locks(c, inv_id, slug, doc, prev or frame, tool="write_document", by=by)
    if refused is not None:
        refused.extend(reverted)
    doc["comments"] = carry_comments(prev, doc, doc["generation"])
    placed = place_pinned(doc, pinned_figures(prev, frame))
    if placed:
        log.info("%s/%s: %d pinned figure(s) the writer left out were put back", c, slug, placed)
    if isinstance(doc.get("slides"), list):
        slides.carry_layouts(doc, prev, frame)
    elif doc.get("renderer") == "story":
        from . import story  # noqa: PLC0415

        story.carry_cards(doc, prev, frame)
    doc["snapshot"] = revise_diff.snapshot(c, inv_id, doc)
    instruction = revise_diff.typed_instruction(request)
    if instruction:
        doc["instructions"] = instruction
    return doc


# --------------------------------------------------------------------------- rewriting a passage

SPAN_RE = re.compile(r"^report:([a-z0-9][a-z0-9-]*)#([A-Za-z0-9_-]+)$")


def parse_span(span: str, doc: dict[str, Any] | None = None) -> tuple[str, str]:
    """(slug, unit id) of a `report:<slug>#<id>` ref, a paragraph's being `#p<id>`; 400 when it is not one. With the
    document, an id it holds is taken as written, since an id the editor minted may itself start with p; without it,
    or when it holds none, a leading p is the paragraph's mark."""
    m = SPAN_RE.match(str(span or "").strip())
    if not m:
        raise HTTPException(400, f"{span!r} is not a report:<slug>#<id> span")
    raw = m.group(2)
    if doc is not None and raw in _ids(doc):
        return m.group(1), raw
    return m.group(1), raw[1:] if raw.startswith("p") and len(raw) > 1 else raw


def _locate_span(doc: dict[str, Any], uid: str) -> tuple[dict[str, Any], dict[str, Any] | None, list[dict[str, Any]], list[dict[str, Any]]]:
    """(unit, paragraph or None, the list holding the passage's sentences, the sentences of the passage) for a
    sentence or a paragraph id; 404 when neither."""
    hit = find_paragraph(doc, uid)
    if hit is not None:
        unit, para = hit
        return unit, para, para.setdefault("sentences", []), list(para["sentences"])
    t = find_target(doc, uid)
    if t["kind"] == "heading" and "heading" not in t["unit"] and isinstance(t["unit"].get("sentences"), list):
        return t["unit"], None, t["unit"]["sentences"], list(t["unit"]["sentences"])  # a video's line, whole
    if t["kind"] != "sentence" or t.get("unit") is None:
        raise HTTPException(404, f"no sentence or paragraph {uid}")
    unit, sentence = t["unit"], t["sentence"]
    for p in unit.get("paragraphs") or []:
        if isinstance(p, dict) and any(x is sentence for x in p.get("sentences") or []):
            return unit, p, p["sentences"], [sentence]
    if isinstance(unit.get("sentences"), list) and any(x is sentence for x in unit["sentences"]):
        return unit, None, unit["sentences"], [sentence]
    for v in unit.values():
        if isinstance(v, list) and any(x is sentence for x in v):
            return unit, None, v, [sentence]
    raise HTTPException(404, f"no sentence or paragraph {uid}")


def _save_edit(c: str, inv_id: str, slug: str, doc: dict[str, Any], before: dict[str, Any], actor: str) -> list[str]:
    """A model's edit of one passage stored, every block the analyst locked put back first as it was in `before`, the
    document as the edit read it (hold_locks), so no edit, whatever it reached, changes a locked block. Returns the
    refs put back."""
    reverted = hold_locks(c, inv_id, slug, doc, before, tool="edit_document", by=actor)
    write_doc(c, inv_id, slug, doc)
    return reverted


async def replace_passage(c: str, slug: str, uid: str, text: str, entry: dict[str, Any], *, span: str | None = None,
                          inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """One sentence or paragraph of a written document replaced by `text` as sentence records: refs checked and tagged,
    the
    former text in its unit's history under `entry`, comments carried or settled. The new sentences are not locked.
    Emits
    `report {status: rewritten, span}`. Returns {text, ids, unverified, reverted}. The edit_document tool lands here."""
    from . import report, report_format  # noqa: PLC0415

    doc = _load(c, inv_id, slug)
    before = copy.deepcopy(doc)
    unit, para, holder, passage = _locate_span(doc, uid)
    used = _ids(doc)
    # read_ref's marks copied back with the text are no words of it
    text, marked_by = strip_marks(text)
    if para is not None and para.get("kind") == "quote":
        # a story's quote stays its quote block, its speaker named in a `> — Name` line or kept
        q, _ = slides.split_quote([text.strip()])
        q = q or {"text": text, "speaker": ""}
        if q["speaker"] or marked_by:
            para["speaker"] = q["speaker"] or marked_by
        new = report_format.sentence_units(q["text"], _Refs(c), used)
    elif len(passage) == 1 and passage[0].get("quote"):
        # a slide's quote stays its quote cell: the text is the quote, in `> ` lines with a `> — Speaker` line or bare,
        # and a
        # speaker it does not name stays the one it had
        q, _ = slides.split_quote([text.strip()])
        q = q or {"text": text, "speaker": ""}
        speaker = q["speaker"] or marked_by or passage[0].get("speaker") or ""
        rec = slides.quote_record({"text": q["text"], "speaker": speaker}, _Refs(c), used)
        new = [rec] if rec else []
    else:
        new = report_format.sentence_units(text, _Refs(c), used)
    if not new:
        raise HTTPException(400, "the new passage has no sentence")
    await report.verify_and_tag(c, new)
    old_ids = [str(x.get("id")) for x in passage]
    passage_text = report_format.body_of(passage)
    start = next((i for i, x in enumerate(holder) if passage and x is passage[0]), 0)
    holder[start:start + len(passage)] = new
    if para is not None and para.get("kind") == "divider":
        para.pop("kind")
    node = para if para is not None else unit
    node.setdefault("history", []).append({"text": passage_text, "ts": _now(), **entry})
    node["rewritten_at"] = _now()
    by_text = {str(x.get("text") or ""): str(x["id"]) for x in new}
    for cm in doc.get("comments") or []:
        if str(cm.get("sentence_id")) not in old_ids:
            continue
        was_on = next((str(x.get("text") or "") for x in passage if str(x.get("id")) == str(cm.get("sentence_id"))), "")
        cm.setdefault("was_on", was_on)
        if was_on in by_text:
            cm["sentence_id"] = by_text[was_on]
        else:
            settle_carried_comment(cm, anchored=False, generation=int(doc.get("generation") or 1))
    reverted = _save_edit(c, inv_id, slug, doc, before, str(entry.get("actor") or entry.get("by") or "model"))
    _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": span or f"report:{slug}#{uid}"})
    return {"text": report_format.body_of(new), "ids": [str(x["id"]) for x in new],
            "unverified": [str(x["id"]) for x in new if "unverified" in (x.get("tags") or [])], "reverted": reverted}


def replace_heading(c: str, slug: str, uid: str, text: str, actor: str, *, span: str | None = None,
                    inv_id: str = investigation.MAIN) -> dict[str, Any] | None:
    """A section's heading replaced by `text` (its `## ` marks dropped), the former heading in the unit's history, not
    locked.
    Returns {text, ids, reverted}, or None when `uid` names no heading."""
    doc = _load(c, inv_id, slug)
    before = copy.deepcopy(doc)
    try:
        target = find_target(doc, uid)
    except HTTPException:
        return None
    if target["kind"] != "heading" or "heading" not in target["unit"]:
        return None
    heading = _collapse(re.sub(r"^#+[ \t]+", "", text.strip()))
    if not heading or "\n" in text.strip():
        raise HTTPException(400, "a heading is replaced by one line of text")
    unit = target["unit"]
    reverted: list[str] = []
    if heading != (unit.get("heading") or ""):
        _replace_text(unit, "heading", heading, "edit", actor=actor)
        reverted = _save_edit(c, inv_id, slug, doc, before, actor)
        _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": span or f"report:{slug}#{uid}"})
    return {"text": heading, "ids": [uid], "unverified": [], "reverted": reverted}


# --------------------------------------------------------------------------- a document written as markdown
# The writer saves a whole document as markdown, each form reading it its own way (prompts/report-<form>.md). `# ` opens
# the title and `## ` a section or a slide; in a document `### ` or deeper opens a subsection with that `level`. A line
# that is only `![caption](card:<id>)` (or `cell:<id>`) is a figure. In a story a `### ` line is a headline; in a deck a
# paragraph starting `Notes` is the speaker notes; a page is its title, one ```html block and its claims, and a video its
# title, its lines as a page's claims and its film as the ```html block.

_MD_TITLE_RE = re.compile(r"^#[ \t]+(.+?)[ \t]*#*[ \t]*$")
_MD_HEADING_RE = re.compile(r"^#{2,6}[ \t]+(.+?)[ \t]*#*[ \t]*$")
# a figure line: its caption may hold brackets, such as a citation or "[run 3]", since the line ends at the card; a title in
# quotes after the card is a story's step on that figure (story.py)
_MD_FIGURE_RE = re.compile(r"^!\[(.*)\]\(\s*((?:card|cell):[A-Za-z0-9_-]+)(?:\s+\"([^\"]*)\")?\s*\)$")
_MD_LEAD_RE = {"stakes": re.compile(r"^\**stakes\**\s*[:.\-–—]\**\s*", re.I), "notes": re.compile(r"^\**(?:speaker )?notes\**\s*[:.\-–—]\**\s*", re.I),
               "layout": re.compile(r"^\**layout\**\s*[:.\-–—]\**\s*", re.I)}
_MD_HTML_RE = re.compile(r"^```html[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S | re.I)
_MD_BULLET_RE = re.compile(r"^\s*(?:[-*+•]|\d{1,2}[.)])\s+")


def _md_sections(text: str, *, headlines: bool = False) -> tuple[str, list[dict[str, Any]]]:
    """(title, [{heading, level, lines, figures}]) of a markdown document: the first `# ` line before any text is the
    title, each `## ` (or deeper) line opens a section of that level (the number of `#`), and a figure line becomes
    {cell, caption, after_paragraph}, the number of paragraphs above it in its section. Text before the first heading is
    a section with no heading. With `headlines`, a `### ` (or deeper) line stays in its section's lines."""
    title = ""
    sections: list[dict[str, Any]] = []
    cur: dict[str, Any] = {"heading": "", "lines": [], "figures": []}

    def close() -> None:
        if "".join(cur["lines"]).strip() or cur["figures"] or cur["heading"]:
            sections.append(cur)

    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        st = line.strip()
        if not title and not sections and not "".join(cur["lines"]).strip() and (m := _MD_TITLE_RE.match(st)):
            title = m.group(1)
            continue
        if (m := _MD_HEADING_RE.match(st)) and not (headlines and st.startswith("###")):
            close()
            cur = {"heading": m.group(1), "level": len(st) - len(st.lstrip("#")), "lines": [], "figures": []}
            continue
        if m := _MD_FIGURE_RE.match(st):
            done = [q for q in re.split(r"\n\s*\n", "\n".join(cur["lines"]).strip()) if q.strip()]
            fig = {"cell": m.group(2), "caption": m.group(1).strip(), "after_paragraph": len(done) or None}
            if m.group(3):
                fig["step"] = m.group(3).strip()
            cur["figures"].append(fig)
            continue
        cur["lines"].append(line)
    close()
    return title, sections


def _paragraphs(lines: list[str]) -> list[str]:
    return [q.strip() for q in re.split(r"\n\s*\n", "\n".join(lines).strip()) if q.strip()]


def _lead(kind: str, paras: list[str]) -> tuple[str, list[str]]:
    """(the text of the paragraphs that start with the `kind` label, the other paragraphs)."""
    hits, rest = [], []
    for q in paras:
        m = _MD_LEAD_RE[kind].match(q)
        (hits if m else rest).append(q[m.end():].strip() if m else q)
    return " ".join(hits), rest


def parse_markdown(text: str, form: str) -> dict[str, Any]:
    """The shape a form's normalizer reads from a document written as markdown (module note above): for a document
    {title, sections: [{heading, level, body, figures}]}, for a story {title, sections: [{heading, body, figures}]}, for
    slides {title, slides: [{heading, body, figure, notes}]}, for a page {title, html, claims}, for a video {title,
    lines, film} (video.parse)."""
    if form in ("page", "video"):
        m = _MD_HTML_RE.search(str(text or ""))
        html = m.group(1) if m else ""
        rest = (text[: m.start()] + text[m.end():]) if m else str(text or "")
        title, secs = _md_sections(rest)
        if form == "video":
            from . import versions, video  # noqa: PLC0415

            changed = [sec for sec in secs if versions._norm_heading(sec["heading"]) == versions.WHAT_CHANGED]
            summary = [versions.plain(x) for x in _claims(changed)][:versions.SUMMARY_LINES]
            return video.parse(title, _claims([sec for sec in secs if sec not in changed]), html, summary)
        return {"title": title, "html": html, "claims": _claims(secs)}
    # the citation forms the grammar does not know put right, as a takeaway's are (`[23 June|card:<id>#day/06-23]`, a
    # Markdown link to a ref, `[[↗|ref]]`): a writer wrote `[v|ref]` and the document showed it as written (live check
    # term-fix7)
    text = cite.normalise_markup(str(text or ""))
    title, secs = _md_sections(text, headlines=form == "story")
    if form == "slides":
        out = []
        for sec in secs:
            notes, paras = _lead("notes", _paragraphs(sec["lines"]))
            layout, paras = _lead("layout", paras)
            quote, paras = slides.split_quote(paras)
            out.append({"heading": sec["heading"], "body": "\n\n".join(paras), "notes": notes, "layout": layout.strip().lower(),
                        "quote": quote, "figures": [{"cell": f["cell"], "caption": f["caption"]} for f in sec["figures"]]})
        return {"title": title, "slides": out}
    if form == "story":
        return {"title": title, "sections": [{"heading": sec["heading"], "body": "\n".join(sec["lines"]).strip(), "figures": sec["figures"]}
                                             for sec in secs]}
    return {"title": title, "sections": [{"heading": sec["heading"], "level": sec.get("level") or 2,
                                          "body": "\n".join(sec["lines"]).strip(), "figures": sec["figures"]}
                                         for i, sec in enumerate(secs)
                                         if "".join(sec["lines"]).strip() or sec["figures"] or over_subheading(secs, i)]}


def _claims(secs: list[dict[str, Any]]) -> list[str]:
    """Each paragraph of the sections as one claim, or each item of a paragraph that is all a list."""
    claims: list[str] = []
    for sec in secs:
        for para in _paragraphs(sec["lines"]):
            rows = [r for r in para.split("\n") if r.strip()]
            if all(_MD_BULLET_RE.match(r) for r in rows):
                claims += [_MD_BULLET_RE.sub("", r).strip() for r in rows]
            else:
                claims.append(" ".join(r.strip() for r in rows))
    return claims


def over_subheading(secs: list[dict[str, Any]], i: int) -> bool:
    """Whether the section at `i` is a heading whose next section is a deeper one, its subheading, so it stands even
    with no text of its own."""
    nxt = secs[i + 1] if i + 1 < len(secs) else None
    return (bool(_collapse(secs[i].get("heading"))) and isinstance(nxt, dict)
            and _level(nxt.get("level")) > _level(secs[i].get("level")))


def _level(value: Any) -> int:
    """A heading's level as stored: 2 unless it names a deeper one, at most 6."""
    return min(value, 6) if isinstance(value, int) and value > 2 else 2


def form_of(t: dict[str, Any]) -> str | None:
    """The markdown form a type is written in: document, slides, story, video or page; None for a custom type with a
    schema of its own, which is not written from markdown."""
    if t.get("renderer") in ("document", "slides", "story", "video"):
        return str(t["renderer"])
    return "page" if t.get("page") else None


# --------------------------------------------------------------------------- a document as its writer reads it
# read_ref on `report:<slug>` gives the document whole, every passage with the id that cites or edits it, what the
# analyst locked and pinned, the open comments and what changed in the workspace since it was written; for a document
# not written yet, the frame the analyst laid out. The explanatory lines are the `## read_ref-document` and
# `## read_ref-frame` sections of prompts/tools.md.

READ_HTML_CHARS = 40_000


def _marks(x: dict[str, Any]) -> str:
    out = []
    if x.get("quote"):
        out.append("quote" + (f" by {_collapse(x.get('speaker'))}" if _collapse(x.get("speaker")) else ""))
    if x.get("pinned") and x.get("by") == ANALYST:
        out.append("the analyst's")
    if "unverified" in (x.get("tags") or []):
        note = _collapse((x.get("tag_notes") or {}).get("unverified"))
        out.append("unverified" + (f" ({note})" if note else ""))
    return "".join(f" · {m}" for m in out)


# the marks _marks writes after a passage's text in read_ref, which a model may copy back with the text it edits
_MARKS_RE = re.compile(r"(?:\s+·\s+(?:quote(?:\s+by\s+[^·]+?)?|locked|the analyst's|unverified(?:\s+\([^)]*\))?))+\s*$")
_QUOTE_BY_RE = re.compile(r"·\s+quote\s+by\s+([^·]+?)\s*(?=·|$)")


def strip_marks(text: str) -> tuple[str, str]:
    """(the text without the read_ref marks a model copied after it, the speaker a `· quote by` mark among them named)."""
    m = _MARKS_RE.search(text or "")
    if not m:
        return text, ""
    by = _QUOTE_BY_RE.search(m.group(0))
    return text[:m.start()].rstrip(), (by.group(1).strip() if by else "")


def _marks_of(unit: dict[str, Any]) -> str:
    """The markdown marks of a unit's heading: `##`, or `###` and deeper for a subheading (a section's `level`)."""
    return "#" * _level(unit.get("level"))


def _sentence_lines(sentences: list[dict[str, Any]], pad: str = "") -> list[str]:
    return [f"{pad}#{x.get('id')} {x.get('text') or ''}{_marks(x)}" for x in sentences if isinstance(x, dict)]


def _figure_line(f: dict[str, Any]) -> str:
    from . import story  # noqa: PLC0415

    if not isinstance(f, dict):
        return ""
    # a story's step on its card, in the quotes the writer wrote it in (story.step_of), and a picture of a card's
    step = f"callout: {_collapse(f['callout'])}" if f.get("callout") else ", ".join(str(t) for t in f.get("highlight") or [])
    step = step or (story.IMAGE if f.get("role") == story.IMAGE else "")
    card = cite.canon(str(f.get("cell"))) + (f' "{step}"' if step else "")
    what = f"![{_collapse(f.get('caption'))}]({card})" if f.get("cell") else f"(a figure asked for, not drawn: {_collapse(f.get('make'))})"
    return (f"{what} · #{f.get('id')}" + story.figure_mark(f) + (" · pinned" if f.get("pinned") else "")
            + (" · locked" if f.get("locked") is True else ""))


def document_lines(doc: dict[str, Any]) -> list[str]:
    """Every passage of a document or a frame, of any form, on its own line with its id. `locked` marks a block the
    analyst
    locked. A deck's slides carry their number as shown in the rail, since the deck's title is no slide."""
    from . import story  # noqa: PLC0415

    lines = [f"# {doc.get('title') or '(no title)'}" + (" · locked" if doc.get("title_locked") is True else "")]
    if doc.get("renderer") == "video":
        from . import video  # noqa: PLC0415

        return lines + video.document_lines(doc, _sentence_lines, READ_HTML_CHARS)
    answer = doc.get("answer") if isinstance(doc.get("answer"), dict) else None
    if answer:
        lines += ["", "answer"] + _sentence_lines([answer])
    deck = isinstance(doc.get("slides"), list)
    told = story.is_story(doc)
    for n, u in enumerate(units(doc), 1):
        lines += ["", f"{_marks_of(u)} {u.get('heading') or '(no heading)'} · #{u.get('id')}" + (f" · slide {n}" if deck else "")
                  + (story.section_mark(u) if told else "") + (" · locked" if u.get("locked") is True else "")]
        if isinstance(u.get("paragraphs"), list):
            figs = [f for f in u.get("figures") or [] if isinstance(f, dict)]
            for f in (f for f in figs if not f.get("after_paragraph")):
                lines.append(_figure_line(f))
            for p in u["paragraphs"]:
                if not isinstance(p, dict):
                    continue
                lines.append(f"¶ #p{p.get('id')}" + (story.paragraph_mark(p) if told else "")
                             + (" · the analyst's" if p.get("pinned") and p.get("by") == ANALYST else "")
                             + (" · locked" if p.get("locked") is True else ""))
                lines += _sentence_lines(p.get("sentences") or [], "  ")
                lines += [_figure_line(f) for f in figs if str(f.get("after_paragraph") or "") == str(p.get("id"))]
            known = {str(p.get("id")) for p in u["paragraphs"] if isinstance(p, dict)}
            lines += [_figure_line(f) for f in figs if f.get("after_paragraph") and str(f["after_paragraph"]) not in known]
        else:
            lines += _sentence_lines(unit_sentences(u))
            for f in [u.get("figure")] + list(u.get("figures") or []):
                if isinstance(f, dict):
                    lines.append(_figure_line(f))
            if deck:
                lines.append(f"layout {slides.preset_of(u)}" + slides.slots_note(u))
            for key in ("stakes", "notes"):
                if _collapse(u.get(key)):
                    lines.append(f"{key} {_collapse(u.get(key))}")
    if is_custom(doc):
        claims = doc.get("claims") if isinstance(doc.get("claims"), list) else []
        if claims:
            lines += ["", "claims"] + _sentence_lines(claims)
        html = str(doc.get("html") or "")
        if html:
            lines += ["", "```html", html[:READ_HTML_CHARS] + ("\n… (cut)" if len(html) > READ_HTML_CHARS else ""), "```"]
    return lines


def _comment_lines(c: str, doc: dict[str, Any]) -> list[str]:
    """The open comments, each by its author, a check's by the check's name."""
    from . import checks  # noqa: PLC0415 — checks imports this module

    names = checks.names(c)
    out = []
    for cm in anchored_open_comments(doc):
        who = names.get(str(cm["check"]), str(cm["check"])) if cm.get("check") else \
            str(cm.get("author") or ANALYST) + (f", {cm['kind']}" if cm.get("kind") else "")
        out.append(f"- #{cm.get('sentence_id')} · {who} · {_collapse(cm.get('text'))}")
    return out


def document_text(c: str, t: dict[str, Any], doc: dict[str, Any], is_doc: bool) -> str:
    """read_ref's answer for `report:<slug>` (section note above)."""
    from . import revise_diff, tools  # noqa: PLC0415

    slug = str(t["slug"])
    name = str(t.get("name") or slug)
    if is_doc:
        head = [f"report:{slug} · {name} · generation {doc.get('generation') or 1} · {doc_words(doc)} words"
                + (f" · written {str(doc.get('generated_at'))[:16].replace('T', ' ')}" if doc.get("generated_at") else ""),
                tools.hint("read_ref-document", slug=slug)]
    elif units(doc) or _collapse(doc.get("title")):
        head = [f"report:{slug} · {name} · not written yet", tools.hint("read_ref-frame", slug=slug)]
    else:
        return "\n".join(x for x in (f"report:{slug} · {name} · not written yet", tools.hint("read_ref-new", slug=slug)) if x)
    lines = [x for x in head if x] + [""] + document_lines(doc)
    reverted = [str(r.get("ref")) for r in current_reverts(doc)] if is_doc else []
    if reverted:
        lines += ["", reverted_line(reverted)]
    comments = _comment_lines(c, doc)
    if comments:
        lines += ["", "open comments"] + comments
    if is_doc:
        try:
            changed = revise_diff.changes_since(c, investigation.MAIN, doc)
        except Exception:  # noqa: BLE001
            log.exception("%s/%s: what changed since the last generation could not be read", c, slug)
            changed = ""
        if changed:
            lines += ["", f"changed since generation {doc.get('generation') or 1} was written", changed]
    return cite.canon_text("\n".join(lines).rstrip())


async def tool_read_ref(ctx: Any, args: dict[str, Any]) -> Any:
    """`read_ref` of a whole document, `report:<slug>`: the document or its frame as document_text writes it. A passage
    of a document (`report:<slug>#<id>`) reads as the excerpt refs.resolve gives, in tools."""
    from . import tools  # noqa: PLC0415

    ref = str(args.get("ref") or "").strip()
    m = re.fullmatch(r"report:([a-z0-9][a-z0-9-]*)", ref)
    t = read_type(ctx.c, m.group(1)) if m else None
    if t is None:
        return tools.err(f"read_ref: no document {ref!r}; the documents are " + ", ".join(f"report:{x['slug']}" for x in list_types(ctx.c)))
    target, is_doc = frame_or_doc(ctx.c, investigation.MAIN, t["slug"])
    return tools.ok(document_text(ctx.c, t, target, is_doc))


# --------------------------------------------------------------------------- a write the analyst asked for
# Write in the browser starts the document's writer through thimble's module, and main's start_writing makes a typed one
# (write_session.py). begin_write marks the document as being written: the stream says `report {status: generating}`
# until the document is saved whole or the writer's chat finishes (writer_finished), ending as `generated` or `failed`,
# or `refused` when the writer did not start (write_refused). A request nobody answers ends after WRITE_WAIT_S.

WRITE_EVENT = "write"  # a writer's chat is titled `Write <doc>` (writer_finished)
WRITER_AGENT = "writer"  # prompts/writer.md's name, the agent type of a writer's session chat (write_session.py)
WRITE_WAIT_S = 30 * 60
_writes: dict[tuple[str, str], dict[str, Any]] = {}


def write_pending(c: str, slug: str) -> dict[str, Any] | None:
    """The write requested for a document and not ended yet, or None; one older than WRITE_WAIT_S is dropped."""
    w = _writes.get((c, slug))
    if w is not None and time.monotonic() - w["t0"] > WRITE_WAIT_S:
        _writes.pop((c, slug), None)
        return None
    return w


def write_saved(c: str, slug: str) -> bool:
    """Whether the pending write of `slug` saved the document."""
    w = _writes.get((c, slug))
    return bool(w and w.get("saved"))


def write_for_orientation(c: str, slug: str, chat: str, run: int = 0) -> None:
    """The pending write of `slug` is the orientation's report pass (orientation.request_report): its writer carries the
    orientation's chat and run, and the browser shows it on the orientation's card."""
    w = write_pending(c, slug)
    if w is not None:
        w.update(orient=chat, orient_run=int(run or 0))


def _writer_chat(ctx: Any) -> str | None:
    """The chat of the writer a call comes from (its key `writer:<doc>`, subagents.caller), named as `writer` on a
    save's chip; None for any other caller."""
    key = str(getattr(ctx, "session", None) or "")
    if not key.startswith("writer:"):
        return None
    from . import subagents  # noqa: PLC0415 — subagents is loaded after this module

    run = subagents.current(ctx.c, key)
    return run.chat if run is not None else None


def begin_write(c: str, slug: str, request: str | None = None, after: str | None = None) -> dict[str, Any]:
    """A writer is starting for `slug` (write_session.start): the pending write, or a new one, so the Report tab shows
    the document as being written."""
    w = write_pending(c, slug)
    if w is not None:
        return w
    w = _writes[(c, slug)] = {"event": None, "t0": time.monotonic(), "ts": _now(), "saved": False,
                              "request": _collapse(request) or None, "after": after or None}
    _emit(c, {"type": "report", "slug": slug, "status": "generating", "by": ANALYST, "run": None})
    return w


def _write_saved(c: str, slug: str, *, whole: bool) -> dict[str, Any] | None:
    """A save of the document while a write is pending: a whole document ends it, a passage marks it saved. Returns
    the pending write."""
    w = write_pending(c, slug)
    if w is not None:
        w["saved"] = True
        if whole:
            _writes.pop((c, slug), None)
    return w


def writer_finished(c: str, meta: dict[str, Any]) -> None:
    """An agent chat ended: when it was a writer's, the write of its own document ends (found by the chat's `doc`, its
    title,
    or the last word of a title naming a pending write). Another document's write is never ended here."""
    kind = str(meta.get("agent_type") or "").rsplit(":", 1)[-1]
    title = _collapse(meta.get("title")).lower()
    if kind != WRITER_AGENT and not title.startswith(WRITE_EVENT + " "):
        return
    pending = [s for (cc, s) in list(_writes) if cc == c]
    named = str(meta.get("doc") or "").strip().lower()
    if not named and title.startswith(WRITE_EVENT + " "):
        rest = title.split(" ", 1)[1].strip()
        named = rest if rest in pending else next((w for w in reversed(rest.split()) if w in pending), rest)
    slugs = [s for s in pending if s == named]
    for slug in slugs:
        w = _writes.pop((c, slug), None)
        if w is None:
            continue
        if w["saved"]:
            _emit(c, {"type": "report", "slug": slug, "status": "generated", "run": w.get("event")})
        elif meta.get("plan_mode"):
            # main went into plan mode while it wrote, and the writer with it, so it could only write a plan (live check
            # L21): a failure the analyst can write again, never a document found to need no change
            from . import subagents  # noqa: PLC0415

            _emit(c, {"type": "report", "slug": slug, "status": "failed", "run": w.get("event"), "chat": meta.get("id"),
                      "note": subagents.plan_failed_line(WRITER_AGENT)})
        elif meta.get("status") == "done" and read_doc(c, investigation.MAIN, slug) is not None:
            # a revision whose writer ended well and changed nothing (it read the document and found nothing to change)
            _emit(c, {"type": "report", "slug": slug, "status": "generated", "unchanged": True, "run": w.get("event"),
                      "note": _cut(meta.get("result") or "", 300)})
        else:
            # the writer's chat goes with it, so the browser's Report a problem can take that chat first
            _emit(c, {"type": "report", "slug": slug, "status": "failed", "run": w.get("event"), "chat": meta.get("id"),
                      "note": _cut(meta.get("result") or "the writer ended without saving the document", 300)})


def write_refused(c: str, slug: str, reason: str, kind: str, **fields: Any) -> None:
    """A writer's start that did not happen (write_session.subagent_refused): its pending write ends, and the stream
    says `report {status: refused, refused: {reason, kind, …}}`, which the document's card shows with the kind's
    buttons."""
    _writes.pop((c, slug), None)
    _emit(c, {"type": "report", "slug": slug, "status": "refused",
              "refused": {"reason": reason, "kind": kind, **{k: v for k, v in fields.items() if v is not None}}})


def cancel_workspace(c: str) -> list[str]:
    """Forget the writes pending for a workspace (a reset); returns their slugs. A writer's session runs on, and its
    chat's end finds nothing to end."""
    slugs = [s for (cc, s) in list(_writes) if cc == c]
    for s in slugs:
        _writes.pop((c, s), None)
    return slugs


def _listen() -> None:
    """writer_finished on every agent chat's end."""
    from . import agents  # noqa: PLC0415

    agents.on_agent_finished(writer_finished)


# --------------------------------------------------------------------------- the tools this module runs (tools.REGISTRY)


def _plural(k: int, noun: str) -> str:
    return f"{k} {noun}" if k == 1 else f"{k} {noun}s"


def reverted_line(refs: list[str]) -> str:
    """The `## write_document-locked` line naming the locked blocks a model's save changed and thimble put back: in the
    result of the save, and in what the writer reads next (read_ref, context.documents)."""
    from . import tools  # noqa: PLC0415

    return tools.hint("write_document-locked", blocks=_plural(len(refs), "block"), refs=", ".join(refs)) or ", ".join(refs)


def writer_run(ctx: Any) -> str | None:
    """`<chat>:<run>` of the writer session a call comes from (its THIMBLE_SESSION is `writer:<doc>`), the key that
    makes its saves one generation; None for any other caller, whose every save is a generation of its own."""
    from . import subagents, tools  # noqa: PLC0415

    if tools.session_kind(getattr(ctx, "session", None)) != tools.WRITER_SESSION:
        return None
    run = subagents.current(ctx.c, ctx.session)
    return f"{run.chat}:{run.k}" if run is not None else None


async def tool_write_document(ctx: Any, args: dict[str, Any]) -> Any:
    """The `write_document` tool: a whole document in its form's markdown saved as the type's new generation, or, for a
    later
    save of the same writer run, as that generation updated in place (versions.py). The markdown is made into
    sentence
    records, locked blocks put back, comments and pinned figures carried (finish_generation), the citation check run,
    and
    a closing `What changed` section kept as the version's summary. The result names reverted locked blocks and
    sentences
    tagged unverified."""
    from . import agents, report, tools, versions  # noqa: PLC0415

    slug = str(args.get("doc") or "").strip().lower()
    text = str(args.get("text") or "")
    if not slug:
        return tools.err("write_document: `doc` is required, the document's slug")
    if not text.strip():
        return tools.err("write_document: `text` is empty")
    t = read_type(ctx.c, slug)
    if t is None:
        return tools.err(f"write_document: no document type {slug!r}; the types are {', '.join(x['slug'] for x in list_types(ctx.c))}")
    form = form_of(t)
    if form is None:
        return tools.err(tools.hint("write_document-form", doc=slug) or f"write_document: the {slug} is not written from markdown")
    inv = investigation.MAIN
    prev = read_doc(ctx.c, inv, slug)
    # one writer run is one generation: a later save of the run that wrote the current generation updates it in place,
    # the save it replaces kept as a revision (versions.add_revision), and `base`, what the generation is compared
    # with, is still the generation before the run
    run_key = writer_run(ctx)
    same_run = bool(run_key and prev is not None and prev.get("writer_run") == run_key)
    base = versions.previous_of(ctx.c, inv, slug, int(prev.get("generation") or 1)) if same_run and prev else prev
    raw = parse_markdown(text, form)
    what_changed = (raw.pop("what_changed", None) or versions.pop_what_changed(raw)) if base is not None else []
    # the cards the writer's figure lines named, to say which of them the saved document shows
    asked = [str(f.get("cell")) for s in raw.get("sections") or [] for f in s.get("figures") or [] if isinstance(f, dict)] + \
        [str(f.get("cell")) for u in raw.get("slides") or [] for f in (u.get("figures") or [])[:slides.MAX_FIGURES] if isinstance(f, dict)]
    try:
        doc = normalize(t, raw, _Refs(ctx.c))
    except HTTPException as e:
        return tools.err(f"write_document: {e.detail}")
    frame = read_frame(ctx.c, inv, slug) if prev is None else None
    pending = write_pending(ctx.c, slug) or {}
    refused: list[str] = []
    finish_generation(ctx.c, inv, slug, doc, request=pending.get("request"), frame=frame, refused=refused, by=ctx.cell_author,
                      same_run=same_run)
    if run_key:
        doc["writer_run"] = run_key
        doc.setdefault("revision", 1)
    held = locked_sentence_ids(doc)  # a locked block stays as the analyst left it, so the check's repairs skip it
    checked = await report.verify_and_tag(ctx.c, [x for x in all_sentences(doc) if str(x.get("id")) not in held])
    doc.update(generated_at=_now(), model="session", written_by=ctx.cell_author, words=doc_words(doc),
               verified={"status": "done", "ts": _now(), "checked": checked.get("checked", 0),
                         "failed": len(checked.get("failed") or []), "repaired": checked.get("repaired", 0)})
    if what_changed:
        doc["what_changed"] = what_changed
    if same_run and prev is not None:
        versions.add_revision(ctx.c, inv, slug, prev, run=run_key)
    store(ctx.c, inv, slug, doc)
    if frame is not None:
        frame_file(ctx.c, inv, slug).unlink(missing_ok=True)
    event = pending.get("event") or (versions.record_run(ctx.c, inv, slug, doc["generation"]) if same_run else None)
    versions.record(ctx.c, inv, slug, base, doc, source=ctx.cell_author,
                    instructions=pending.get("request") or (doc.get("instructions") if same_run else None), run=event)
    _write_saved(ctx.c, slug, whole=True)
    _emit(ctx.c, {"type": "report", "slug": slug, "status": "generated", "by": ctx.cell_author, "run": event})
    if not same_run:  # one chat row per run: the run's later saves update the generation its row names
        try:
            agents.chip(ctx.c, "artifact", "wrote" if doc["generation"] <= 1 else "revised", ref=f"report:{slug}",
                        status="generated", generation=doc["generation"], writer=_writer_chat(ctx))
        except Exception:  # noqa: BLE001
            log.debug("chip not written", exc_info=True)
    # a figure the writer named stands when the document shows its card, as its own figure or as one the analyst pinned
    # there, which takes its place (place_pinned, slides.carry_layouts)
    shown = {cite.canon(str(f.get("cell"))) for u in units(doc) for f in [u.get("figure"), *(u.get("figures") or [])]
             if isinstance(f, dict) and f.get("cell")}
    kept = sum(1 for cell in asked if cite.canon(cell) in shown)
    saved_as = f"generation {doc['generation']}" + (f" (this run's save {doc['revision']} of it)" if same_run else "")
    if form == "video":
        from . import video  # noqa: PLC0415

        line = (f"saved [[report:{slug}]] as {saved_as}, {_plural(len(units(doc)), 'line')} over "
                f"{video.timing(doc)['duration']:g} s and {_plural(len(all_sentences(doc)), 'sentence')}")
    else:
        line = (f"saved [[report:{slug}]] as {saved_as}, {_plural(len(units(doc)), 'section')}, "
                f"{_plural(len(all_sentences(doc)), 'sentence')} and {_plural(kept, 'figure')}")
    if kept < len(asked):
        line += f"\nleft out {_plural(len(asked) - kept, 'figure')} whose card draws no figure: a figure shows {material.FIGURE_WORDS}"
    if refused:  # hold_locks put back the locked blocks the text changed, so the writer does not report those changes
        line += "\n" + reverted_line(refused)
    if flagged := flagged_lines(slug, all_sentences(doc)):
        line += "\n" + flagged
    return tools.ok(line)


FLAGGED_MAX = 12  # the unverified sentences a save's result names, each with its words and why
FLAGGED_CHARS = 200  # the words of each, cut after this many characters


def flagged_lines(slug: str, sentences: list[dict[str, Any]], ids: list[str] | None = None) -> str:
    """The sentences the citation check tagged unverified (of `ids`, when given), as a save's result names them: each
    one's ref, its words as the reader reads them and why (its note), so the writer re-cites the sentence the check means
    (live check term-fix7, new quirk 1: the result named only `report:report#307a473b`, and the writer replaced the
    sentence before it). '' when none is tagged."""
    want = set(ids) if ids is not None else None
    flagged = [x for x in sentences if "unverified" in (x.get("tags") or []) and (want is None or str(x.get("id")) in want)]
    if not flagged:
        return ""
    rows = [f"the citation check tagged {_plural(len(flagged), 'sentence')} unverified:"]
    for x in flagged[:FLAGGED_MAX]:
        words = _cut(plain_text(str(x.get("text") or "")), FLAGGED_CHARS)
        note = _collapse((x.get("tag_notes") or {}).get("unverified"))
        rows.append(f"- [[report:{slug}#{x['id']}]] “{words}”" + (f" {note}" if note else ""))
    if len(flagged) > FLAGGED_MAX:
        rows.append(f"- … and {len(flagged) - FLAGGED_MAX} more")
    return "\n".join(rows)


async def insert_passage(c: str, slug: str, uid: str, text: str, actor: str, *, inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """A new passage after the one `uid` names: a paragraph of sentence records after its paragraph (checked and tagged,
    as a replaced passage is), or, for a `![caption](card:<id>)` line, a figure on that card placed after it. Returns
    {ref, text?, unverified?, reverted}, `reverted` the locked blocks put back (_save_edit)."""
    from . import report, report_format  # noqa: PLC0415

    doc = _load(c, inv_id, slug)
    before = copy.deepcopy(doc)
    deck = isinstance(doc.get("slides"), list)
    unit = unit_of(doc, uid)
    if unit is None:
        raise HTTPException(404, f"no passage {uid}")
    para = None
    after_fig = next((f for f in unit.get("figures") or [] if isinstance(f, dict) and str(f.get("id")) == uid), None)
    if isinstance(unit.get("paragraphs"), list):
        paras_ = [p for p in unit["paragraphs"] if isinstance(p, dict)]
        if after_fig is not None:
            # after a figure: after the paragraph the figure follows (a figure of its own lands right after it)
            para = next((p for p in paras_ if str(p.get("id")) == str(after_fig.get("after_paragraph") or "")), None)
        elif str(unit.get("id")) == uid:
            para = paras_[-1] if paras_ else None  # after a section's heading span: at the section's end
        else:
            unit, para, _, _ = _locate_span(doc, uid)
    valid = _Refs(c)
    used = _ids(doc)
    if doc.get("renderer") == "story":
        return await _insert_story_blocks(c, inv_id, slug, doc, before, unit, para, text, actor, valid, used)
    fig = _MD_FIGURE_RE.match(text.strip())
    if fig:
        # a slide or a story's beat shows any card, a document's figure a card that draws one (material.figure_kind)
        cid = slides.card_id(valid, fig.group(2)) if deck or doc.get("renderer") == "story" else valid.artifact_id(fig.group(2))
        if cid is None:
            raise HTTPException(400, f"{fig.group(2)} is no card, or draws no figure, so it cannot be one: a figure shows "
                                     f"{material.FIGURE_WORDS}")
        if deck and len(slides.figures_of(unit)) >= slides.MAX_FIGURES:
            raise HTTPException(400, f"the slide shows {slides.MAX_FIGURES} figures already; insert a slide for another")
        rec = {"id": _new_id(used), "cell": f"card:{cid}", "caption": _collapse(fig.group(1)) or valid.artifacts.get(cid, ""),
               "after_paragraph": str(para["id"]) if para is not None else None, "by": actor}
        if not deck and para is None and after_fig is None and isinstance(unit.get("paragraphs"), list):
            rec["lead"] = True
        held_figs = unit.setdefault("figures", [])
        at = next((i + 1 for i, f in enumerate(held_figs) if f is after_fig), len(held_figs))
        held_figs.insert(at, rec)
        if deck:
            slides.grow_slots(unit)
        reverted = _save_edit(c, inv_id, slug, doc, before, actor)
        _emit(c, {"type": "report", "slug": slug, "status": "figures", "span": f"report:{slug}#{rec['id']}"})
        return {"ref": f"report:{slug}#{rec['id']}", "reverted": reverted}
    new = report_format.sentence_units(text, valid, used)
    if not new:
        raise HTTPException(400, "the new passage has no sentence")
    paras = unit.get("paragraphs")
    if not isinstance(paras, list):
        # a slide's or a beat's lines: the new sentences after the one the span names, else at the end
        held = unit.get("sentences")
        if not isinstance(held, list):
            raise HTTPException(400, f"the {slug} has no passage there to insert after; replace the passage instead")
        await report.verify_and_tag(c, new)
        at = next((i + 1 for i, x in enumerate(held) if str(x.get("id")) == uid), len(held))
        held[at:at] = new
        reverted = _save_edit(c, inv_id, slug, doc, before, actor)
        ref = f"report:{slug}#{new[0]['id']}"
        _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": ref})
        return {"ref": ref, "text": report_format.body_of(new), "unverified": [str(x["id"]) for x in new if "unverified" in (x.get("tags") or [])],
                "reverted": reverted}
    if para is None and after_fig is None and paras:
        raise HTTPException(400, f"the {slug} has no paragraph there to insert after; replace the passage instead")
    await report.verify_and_tag(c, new)
    added = {"id": _new_id(used), "sentences": new, "history": [{"text": "", "ts": _now(), "by": "edit", "actor": actor}]}
    # after a figure that leads its section (or into a section with no paragraph), the new paragraph opens the section
    paras.insert(next(i for i, p in enumerate(paras) if p is para) + 1 if para is not None else 0, added)
    reverted = _save_edit(c, inv_id, slug, doc, before, actor)
    ref = f"report:{slug}#p{added['id']}"
    _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": ref})
    return {"ref": ref, "text": report_format.body_of(new), "unverified": [str(x["id"]) for x in new if "unverified" in (x.get("tags") or [])],
            "reverted": reverted}


async def _insert_story_blocks(c: str, inv_id: str, slug: str, doc: dict[str, Any], before: dict[str, Any], unit: dict[str, Any],
                               para: dict[str, Any] | None, text: str, actor: str, valid: _Refs, used: set[str]) -> dict[str, Any]:
    """insert_passage in a story: the blocks `text` holds after `para` (story.insert_blocks), their sentences checked
    and tagged."""
    from . import report, report_format, story  # noqa: PLC0415

    out = story.insert_blocks(unit, para, text, valid, used, actor)
    if out["sentences"]:
        await report.verify_and_tag(c, out["sentences"])
    reverted = _save_edit(c, inv_id, slug, doc, before, actor)
    ref = f"report:{slug}#{out['ref']}"
    _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": ref})
    return {"ref": ref, "text": report_format.body_of(out["sentences"]),
            "unverified": [str(x["id"]) for x in out["sentences"] if "unverified" in (x.get("tags") or [])], "reverted": reverted}


def unit_of(doc: dict[str, Any], uid: str) -> dict[str, Any] | None:
    """The section, slide or beat that is `uid` or holds the sentence, paragraph or figure `uid` names; None for none."""
    for u in units(doc):
        if str(u.get("id")) == uid or any(str(x.get("id")) == uid for x in unit_sentences(u)):
            return u
        if any(isinstance(p, dict) and str(p.get("id")) == uid for p in u.get("paragraphs") or []):
            return u
        if any(isinstance(f, dict) and str(f.get("id")) == uid for f in [u.get("figure"), *(u.get("figures") or [])]):
            return u
    return None


def _units_key(doc: dict[str, Any]) -> str:
    for key in ("beats", "slides", "lines"):
        if isinstance(doc.get(key), list):
            return key
    return "sections"


def _reid(nodes: list[dict[str, Any]], used: set[str]) -> None:
    """Every id in `nodes` minted afresh from `used`, and each figure's `after_paragraph` pointed at its paragraph's new
    id, so units made on their own join a document without an id it already holds."""
    fresh: dict[str, str] = {}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("id"), str):
                fresh[node["id"]] = node["id"] = _new_id(used)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(nodes)

    def point(node: Any) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("after_paragraph"), str):
                node["after_paragraph"] = fresh.get(node["after_paragraph"], node["after_paragraph"])
            for v in node.values():
                point(v)
        elif isinstance(node, list):
            for v in node:
                point(v)

    point(nodes)


async def insert_unit(c: str, slug: str, uid: str, text: str, actor: str, *, inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """New sections, slides or beats after the one that is or holds `uid`, from `text` in the document's markdown (each
    opening with its `## ` heading), made as a write makes them (parse_markdown, normalize) and checked and tagged as
    an inserted passage is; the units around them keep their ids. Returns {ref, ids, unverified, reverted}."""
    from . import report  # noqa: PLC0415

    t = _require_type(c, slug)
    form = form_of(t)
    if form not in ("document", "slides", "story"):
        raise HTTPException(400, f"the {slug} takes no new section; replace a passage instead")
    doc = _load(c, inv_id, slug)
    before = copy.deepcopy(doc)
    host = unit_of(doc, uid)
    if host is None:
        raise HTTPException(404, f"no passage {uid}")
    raw = parse_markdown(text, form)
    try:
        made = units(normalize(t, raw, _Refs(c)))
    except HTTPException as e:
        raise HTTPException(400, f"the new section reads as nothing: {e.detail}") from e
    if not made:
        raise HTTPException(400, "the new section has no heading and no sentence")
    _reid(made, _ids(doc))
    if isinstance(doc.get("slides"), list):
        for s in made:
            s["layout"] = slides.layout_of(s)
    fresh = [x for u in made for x in unit_sentences(u)]
    await report.verify_and_tag(c, fresh)
    for u in made:
        u.setdefault("history", []).append({"text": "", "ts": _now(), "by": "edit", "actor": actor})
    held = doc[_units_key(doc)]
    at = next(i for i, u in enumerate(held) if u is host) + 1
    held[at:at] = made
    reverted = _save_edit(c, inv_id, slug, doc, before, actor)
    ref = f"report:{slug}#{made[0]['id']}"
    _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": ref})
    return {"ref": ref, "ids": [str(u["id"]) for u in made],
            "unverified": [str(x["id"]) for x in fresh if "unverified" in (x.get("tags") or [])], "reverted": reverted}


def set_layout(c: str, slug: str, uid: str, layout: str, *, inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """The layout of the slide that is or holds `uid`, by one of slides.PRESETS, its cards and lines kept, in the
    written deck
    or its frame. 400 for an unknown layout or a document that is not a deck."""
    spec = slides.layout_spec(layout)
    if spec is None:
        raise HTTPException(400, f"no layout {layout!r}; the layouts are {', '.join(slides.PRESETS)}")
    doc, is_doc = frame_or_doc(c, inv_id, slug)
    if not isinstance(doc.get("slides"), list):
        raise HTTPException(400, f"the {slug} is not a deck, so it has no layouts")
    unit = unit_of(doc, uid)
    if unit is None:
        raise HTTPException(404, f"no slide {uid}")
    slides.apply_spec(unit, spec)
    _save_frame_or_doc(c, inv_id, slug, doc, is_doc)
    _emit(c, {"type": "report", "slug": slug, "status": "layout", "span": f"report:{slug}#{unit['id']}"})
    return {"ref": f"report:{slug}#{unit['id']}", "layout": slides.preset_of(unit)}


def set_story_card(c: str, slug: str, uid: str, side: str, *, inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """Where the card of the story section that is or holds `uid` stands (story.set_card). 400 for a document that is
    not a story."""
    from . import story  # noqa: PLC0415

    doc = _load(c, inv_id, slug)
    if not story.is_story(doc):
        raise HTTPException(400, f"the {slug} is not a story, so its sections have no card to move")
    unit = unit_of(doc, uid)
    if unit is None:
        raise HTTPException(404, f"no section {uid}")
    placed = story.set_card(doc, unit, side)
    write_doc(c, inv_id, slug, doc)
    _emit(c, {"type": "report", "slug": slug, "status": "layout", "span": f"report:{slug}#{unit['id']}"})
    return {"ref": f"report:{slug}#{unit['id']}", "card": placed}


def delete_passage(c: str, slug: str, uid: str, *, inv_id: str = investigation.MAIN, actor: str = "model") -> dict[str, Any]:
    """The passage `uid` names taken out of a written document: a section, slide or beat whole, a paragraph, a sentence
    or a figure; a locked block it reached is put back first (hold_locks), then the comments on what went settle as a
    rewritten passage's do (a check's is superseded). Returns {ref, removed, reverted}."""
    doc = _load(c, inv_id, slug)
    before = copy.deepcopy(doc)
    unit = unit_of(doc, uid)
    if unit is None:
        raise HTTPException(404, f"no passage {uid}")
    had = _ids(doc)
    if str(unit.get("id")) == uid:
        key = _units_key(doc)
        doc[key] = [u for u in doc[key] if u is not unit]
    elif (hit := find_paragraph(doc, uid)) is not None:
        _drop_paragraph(hit[0], hit[1])
    elif (fig := next((f for f in [unit.get("figure"), *(unit.get("figures") or [])] if isinstance(f, dict) and str(f.get("id")) == uid), None)) is not None:
        if unit.get("figure") is fig:
            unit["figure"] = None
        unit["figures"] = [f for f in unit.get("figures") or [] if f is not fig]
    else:
        for p in [p for p in unit.get("paragraphs") or [] if isinstance(p, dict)]:
            if any(str(x.get("id")) == uid for x in p.get("sentences") or []):
                p["sentences"] = [x for x in p["sentences"] if str(x.get("id")) != uid]
                if not p["sentences"]:
                    _drop_paragraph(unit, p)
                break
        else:
            unit["sentences"] = [x for x in unit.get("sentences") or [] if str(x.get("id")) != uid]
    reverted = hold_locks(c, inv_id, slug, doc, before, tool="edit_document", by=actor)
    gone = had - _ids(doc)
    for cm in doc.get("comments") or []:
        if isinstance(cm, dict) and str(cm.get("sentence_id")) in gone:
            settle_carried_comment(cm, anchored=False, generation=int(doc.get("generation") or 1))
    write_doc(c, inv_id, slug, doc)
    _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": f"report:{slug}#{uid}"})
    return {"ref": f"report:{slug}#{uid}", "removed": len(gone), "reverted": reverted}


async def tool_edit_document(ctx: Any, args: dict[str, Any]) -> Any:
    """The `edit_document` tool: replace a passage (replace_passage), insert after it (insert_passage, insert_unit), set
    a
    slide's layout, change a block's type, set a story section's card side, or delete the passage. A passage in a
    locked
    block is refused with `## edit_document-locked`; a locked block any edit still reached is put back (hold_locks)."""
    from . import agents, tools  # noqa: PLC0415

    span = str(args.get("span") or "").strip().strip("[]").strip()
    text = str(args.get("text") or "").strip()
    layout = str(args.get("layout") or "").strip()
    block_type = str(args.get("block_type") or "").strip().lower()
    card = str(args.get("card") or "").strip()
    if not span or not (text or layout or block_type or card or args.get("delete")):
        return tools.err("edit_document: `span` is required, with `text`, `layout`, `block_type`, `card` or `delete`")
    try:
        slug, _ = parse_span(span)
        slug, uid = parse_span(span, read_doc(ctx.c, investigation.MAIN, slug) if SLUG_RE.match(slug) else None)
        # a passage inside a block the analyst locked is refused; a passage inserted after it leaves it as it is
        held = None if args.get("insert") else locked_block_ref(read_doc(ctx.c, investigation.MAIN, slug) or {}, slug, uid,
                                                                whole=bool(args.get("delete")))
        if held:
            from . import telemetry  # noqa: PLC0415

            telemetry.note(ctx.c, "lock-refused", held, actor="model", detail={"tool": "edit_document"})
            return tools.err(tools.hint("edit_document-locked", ref=held) or f"edit_document: {held} is locked")
        if args.get("delete"):
            out = delete_passage(ctx.c, slug, uid, actor=ctx.cell_author)
            chip, line = "deleted a passage", f"deleted [[{span}]]"
        elif layout and not text:
            out = set_layout(ctx.c, slug, uid, layout)
            chip, line = "set a slide's layout", f"set the layout of [[{out['ref']}]] to {out['layout']}"
        elif block_type and not text:
            out = set_block_type(ctx.c, slug, uid, block_type, ctx.cell_author)
            chip, line = "changed a block's type", f"turned [[{span}]] into {block_type}, now [[{out['ref']}]]"
        elif card and not text:
            out = set_story_card(ctx.c, slug, uid, card)
            chip, line = "moved a section's card", f"set the card of [[{out['ref']}]] to {out['card']}"
        elif args.get("insert") and _opens_unit(text, (read_type(ctx.c, slug) or {}).get("renderer")):
            out = await insert_unit(ctx.c, slug, uid, text, ctx.cell_author)
            chip, line = "added a section", "inserted " + ", ".join(f"[[report:{slug}#{i}]]" for i in out["ids"]) + f" after [[{span}]]"
        elif args.get("insert"):
            out = await insert_passage(ctx.c, slug, uid, text, ctx.cell_author)
            chip, line = "added a passage", f"inserted [[{out['ref']}]] after [[{span}]]"
        elif _MD_FIGURE_RE.match(text):
            return tools.err("edit_document: a figure is a new passage, so pass `insert`")
        elif (out := replace_heading(ctx.c, slug, uid, text, ctx.cell_author, span=span)) is not None:
            chip, line = "edited a heading", f"replaced the heading [[{span}]]"
        else:
            out = await replace_passage(ctx.c, slug, uid, text, {"by": "edit", "actor": ctx.cell_author}, span=span)
            chip = "edited a passage"
            line = f"replaced [[{span}]], now " + ", ".join(f"[[report:{slug}#{i}]]" for i in out["ids"])
    except HTTPException as e:
        return tools.err(f"edit_document: {e.detail}")
    _write_saved(ctx.c, slug, whole=False)
    try:
        agents.chip(ctx.c, "artifact", "revised", ref=out.get("ref") or span, status="done", what=chip,
                    writer=_writer_chat(ctx))
    except Exception:  # noqa: BLE001
        log.debug("chip not written", exc_info=True)
    if out.get("text"):
        line += f": {out['text'][:300]}"
    if ids := [str(i) for i in out.get("unverified") or []]:
        # each flagged sentence by its words and why, never its id alone (flagged_lines)
        line += "\n" + (flagged_lines(slug, all_sentences(read_doc(ctx.c, investigation.MAIN, slug) or {}), ids)
                        or "the citation check tagged unverified " + " ".join(f"[[report:{slug}#{i}]]" for i in ids))
    if out.get("reverted"):
        line += "\n" + reverted_line(out["reverted"])
    return tools.ok(line)


def _opens_unit(text: str, renderer: str | None) -> bool:
    """Whether inserted text opens a new unit: its first line a heading, in a story a `## ` one (a deeper one is a
    headline among a section's blocks)."""
    first = text.split("\n", 1)[0].strip()
    return bool(_MD_HEADING_RE.match(first)) and not (renderer == "story" and first.startswith("###"))


async def tool_screenshot(ctx: Any, args: dict[str, Any]) -> Any:
    """`screenshot` of a `report:` passage. A figure's passage is its card, so it is the card's picture; a sentence or
    a paragraph has no picture of its own and is read with read_ref. A whole video, `report:<slug>`, is its film's frames
    (video.tool_screenshot)."""
    from . import tools  # noqa: PLC0415

    ref = str(args.get("ref") or "").strip()
    whole = re.fullmatch(r"report:([a-z0-9][a-z0-9-]*)", ref)
    if whole and (read_type(ctx.c, whole.group(1)) or {}).get("renderer") == "video":
        from . import video  # noqa: PLC0415

        doc = read_doc(ctx.c, investigation.MAIN, whole.group(1))
        if doc is None:
            return tools.err(tools.hint("screenshot-none", what=f"{ref} is not written yet") or f"screenshot: {ref} is not written yet")
        return await video.tool_screenshot(ctx, whole.group(1), doc, args)
    try:
        slug, _ = parse_span(ref)
        doc = _load(ctx.c, investigation.MAIN, slug)
        slug, uid = parse_span(ref, doc)
    except HTTPException as e:
        return tools.err(f"screenshot: {e.detail}")
    fig = next((f for u in units(doc) for f in [u.get("figure"), *(u.get("figures") or [])]
                if isinstance(f, dict) and str(f.get("id")) == uid and f.get("cell")), None)
    if fig is None:
        return tools.err(tools.hint("screenshot-none", what=f"{ref} is text, not a figure") or f"screenshot: {ref} is not a figure")
    return await tools._shot_card(ctx, str(fig["cell"]))


# --------------------------------------------------------------------------- export: a document as plain markdown

ISO_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}")
CITE_ID_CHARS = 24
CITE_TS_CHARS = 19
CITE_TITLE_CHARS = 80
CITE_LABEL_CHARS = 24
CELLS_LEGEND = ("Citations of the form card:<id> name the cards below, in order of first citation; card:<id>:out<i>/L<k> "
                "is line k of the card's output i, and card:<id>:<column>×<row> a value in a table of its output.")
_ID_KEYS = ("id", "message_id", "post_id", "event_id", "record_id", "msg_id")
_TS_KEYS = ("timestamp", "created_at", "ts", "time", "datetime", "date", "created", "sent_at", "posted_at")
UNVERIFIED_MARK = "[unverified]"
CELLS_HEADING = "Cards cited"
UNTITLED_CELL = "(untitled card)"


def _is_tldr(heading: Any) -> bool:
    from . import report_format  # noqa: PLC0415

    return bool(report_format.TLDR_RE.match(_collapse(heading)))


def _short_scalar(v: Any, n: int) -> str | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        t = _collapse(v)
        return t if t and len(t) <= n else None
    return None


class _Citations:
    """Resolves a document's refs to citations a reader can reproduce; `titles` lists every cited cell's title."""

    def __init__(self, c: str):
        try:
            self.corpus: Path | None = config.corpus_dir(c)
        except ValueError:
            self.corpus = None
        self.cache: dict[str, str | None] = {}
        self.titles: dict[str, str] = {}

    def cite(self, ref: str) -> str | None:
        if ref not in self.cache:
            self.cache[ref] = self._cite(ref)
        return self.cache[ref]

    def _resolve(self, ref: str) -> dict[str, Any] | None:
        if self.corpus is None:
            return None
        try:
            return refs.resolve(self.corpus, ref)
        except Exception:  # noqa: BLE001
            return None

    def _cite(self, ref: str) -> str | None:
        try:
            p = refs.parse_ref(ref)
        except ValueError:
            return None
        k = p["kind"]
        if k in ("record", "range", "block", "span"):
            base = f"{p['path']}#L{p['line']}" + (f"-L{p['end_line']}" if k == "range" else "")
            return base + self._record_label(self._resolve(ref))
        if k == "row":
            return f"{p.get('path') or 'forge.db'}#{p['table']}/{p['pk']}"
        if k in ("page", "pointer", "csvrow"):
            return refs.format_ref(p) + self._record_label(self._resolve(ref))
        if k == "table":
            return f"{p.get('path') or 'forge.db'}#{p['table']}"
        if k == "path":
            return str(p["path"])
        if k == "cell":
            cid = str(p["cell_id"])
            if not self._cell(cid):
                return None
            if p.get("col") is not None and p.get("row") is not None:
                return f"card:{cid}:{_cut(p['col'], CITE_LABEL_CHARS)}×{_cut(p['row'], CITE_LABEL_CHARS)}"
            if p.get("out") is not None and p.get("line") is not None:
                return f"card:{cid}:out{p['out']}/L{p['line']}" + (f"-L{p['end_line']}" if p.get("end_line") is not None else "")
            return f"card:{cid}"
        if k == "concept":
            res = self._resolve(ref)
            name = _short_scalar(((res or {}).get("meta") or {}).get("name"), CITE_TITLE_CHARS)
            return f"concept “{name}”" if name else None
        return None

    @staticmethod
    def _record_label(res: dict[str, Any] | None) -> str:
        if not res:
            return ""
        srcs = [x for x in (res.get("meta"), res.get("record")) if isinstance(x, dict)]
        ident = next((s for src in srcs for k in _ID_KEYS if (s := _short_scalar(src.get(k), CITE_ID_CHARS))), None)
        ts = next((s for src in srcs for k in _TS_KEYS if (s := _short_scalar(src.get(k), 40))), None)
        parts: list[str] = []
        if ident:
            parts.append(f"id {ident}")
        if ts:
            parts.append(ts[:CITE_TS_CHARS] if ISO_TS_RE.match(ts) else ts)
        return f" ({', '.join(parts)})" if parts else ""

    def _cell(self, cid: str) -> bool:
        if cid in self.titles:
            return True
        res = self._resolve(f"card:{cid}")
        if res is None:
            return False
        self.titles[cid] = _cut(((res.get("meta") or {}).get("title")), CITE_TITLE_CHARS) or UNTITLED_CELL
        return True


def _sentence_refs(x: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for r in list(x.get("refs") or []) + refs.extract_refs(str(x.get("text") or "")):
        if isinstance(r, str) and r.strip() and r not in out:
            out.append(r)
    return out


_BARE_REF_RE = re.compile(r"\[\[([^\[\]|]+)\]\]")
# a bare card ref right after one of these words is read as a noun, as in "the sequence is laid out in [[card:<id>]]"
_NOUN_AFTER = frozenset("in on at by of from into with within under see as and or the a an this that these those its "
                        "their our like via per".split())


def card_nouns(text: str, cites: _Citations) -> str:
    """A sentence's bare refs to a whole card that it reads as nouns, right after a word such as "in" or "the"
    (_NOUN_AFTER), as each card's title in quotes. plain_text drops the others, which cite, as does every ref to a line or
    a cell of a card."""
    def name(m: "re.Match[str]") -> str:
        before = re.search(r"([A-Za-z]+)\s*$", text[: m.start()])
        ref = m.group(1).strip()
        try:
            p = refs.parse_ref(ref)
        except ValueError:
            return m.group(0)
        whole = p.get("kind") == "cell" and "out" not in p and "row" not in p
        if not (whole and before and before.group(1).lower() in _NOUN_AFTER) or not cites.cite(ref):
            return m.group(0)
        cid = str(p["cell_id"])
        meta = (cites._resolve(f"card:{cid}") or {}).get("meta") or {}
        return f"“{' '.join(str(meta.get('title') or '').split()) or cites.titles[cid]}”"

    return _BARE_REF_RE.sub(name, text)


def _sentence_md(x: dict[str, Any], cites: _Citations) -> tuple[str, str]:
    prose = plain_text(card_nouns(str(x.get("text") or ""), cites))
    text = prose + (f" {UNVERIFIED_MARK}" if "unverified" in (x.get("tags") or []) else "")
    labels: list[str] = []
    for r in _sentence_refs(x):
        lab = cites.cite(r)
        if lab and lab not in labels:
            labels.append(lab)
    return (text + (f" [{'; '.join(labels)}]" if labels else "")), prose


def _export_units(doc: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for u in units(doc):
        paragraphs: list[list[dict[str, Any]]]
        if isinstance(u.get("paragraphs"), list):
            paragraphs = [[x for x in (p.get("sentences") or []) if isinstance(x, dict)]
                          for p in u["paragraphs"] if isinstance(p, dict)]
        else:
            paragraphs = [unit_sentences(u)]
        figs = [f for f in (u.get("figures") or []) if isinstance(f, dict)]
        if isinstance(u.get("figure"), dict):
            figs.append(u["figure"])
        out.append({"heading": _collapse(u.get("heading")), "marks": _marks_of(u), "paragraphs": [p for p in paragraphs if p],
                    "figures": figs, "tldr": _is_tldr(u.get("heading"))})
    out.sort(key=lambda u: 0 if u["tldr"] else 1)
    return out


def render_markdown(c: str, doc: dict[str, Any], *, appendix: bool = False) -> dict[str, Any]:
    """The export record of a stored document: every section and sentence as markdown with reproducible citations,
    a summary section first, the cited cells as an appendix when asked. A page has no sections: its claims are a list
    under the title, and its html comes back as `html`, which is the page itself."""
    cites = _Citations(c)
    us = _export_units(doc)
    title = _collapse(doc.get("title")) or _collapse(doc.get("type")) or "Report"
    answer = doc.get("answer") if isinstance(doc.get("answer"), dict) else None
    page_html = doc["html"] if isinstance(doc.get("html"), str) and doc["html"].strip() else None
    claims = [x for x in doc.get("claims") or [] if isinstance(x, dict)] if page_html is not None else []
    lines: list[str] = [f"# {title}", ""]
    prose = [title]
    tldr_words = 0
    if answer:
        text, plain = _sentence_md(answer, cites)
        lines += [text, ""]
        prose.append(plain)
    for x in claims:
        text, plain = _sentence_md(x, cites)
        lines.append(f"- {text}")
        prose.append(plain)
    if claims:
        lines.append("")
    for u in us:
        if u["heading"]:  # an opening under the title has none (report._normalize)
            lines += [f"{u['marks']} {u['heading']}", ""]
            prose.append(u["heading"])
        for para in u["paragraphs"]:
            rendered = [_sentence_md(x, cites) for x in para]
            lines += [" ".join(t for t, _ in rendered), ""]
            prose += [pl for _, pl in rendered]
            if u["tldr"]:
                tldr_words += _words(" ".join(pl for _, pl in rendered))
        for f in u["figures"]:
            raw_caption = str(f.get("caption") or "")
            caption = plain_text(card_nouns(raw_caption, cites))
            labels: list[str] = []
            for r in [str(f.get("cell") or "")] + refs.extract_refs(raw_caption):
                lab = cites.cite(r) if r else None
                if lab and lab not in labels:
                    labels.append(lab)
            if caption:
                lines += [f"*Figure: {caption}*" + (f" [{'; '.join(labels)}]" if labels else ""), ""]
    body = "\n".join(lines).rstrip() + "\n"
    appendix_md = ""
    if cites.titles:
        appendix_lines = ["", f"## {CELLS_HEADING}", "", CELLS_LEGEND, ""]
        appendix_lines += [f"- card:{cid}: {t}" for cid, t in cites.titles.items()]
        appendix_md = "\n".join(appendix_lines).rstrip() + "\n"
    words = _words(body)
    sentences = sum(len(p) for u in us for p in u["paragraphs"]) + (1 if answer else 0) + len(claims)
    return {"markdown": body + (appendix_md if appendix else ""), **({"html": page_html} if page_html is not None else {}),
            "words": words, "prose_words": _words(" ".join(prose)),
            "tldr_words": tldr_words, "has_tldr": any(u["tldr"] for u in us), "tldr_first": bool(us) and us[0]["tldr"],
            "sections": len(us), "sentences": sentences,
            "cells_cited": len(cites.titles), "appendix": bool(appendix and appendix_md), "appendix_words": _words(appendix_md),
            "title": title, "generation": doc.get("generation"), "type": doc.get("type") or doc.get("id")}


def export_markdown(c: str, inv_id: str, slug: str, *, appendix: bool = False) -> dict[str, Any]:
    return render_markdown(c, _load(c, inv_id, slug), appendix=appendix)


# --------------------------------------------------------------------------- ids a model's text names
# A check's comment is read by the analyst, so the bare ids a model writes into it are made readable
# (checks.tool_add_comment).


_HEX8 = r"[0-9a-f]{8}"
_SPAN_TAIL = r"(?:@out\d+#L\d+(?:-L?\d+)?|#[^\s/`]+/[^\s,;)`]+|@\d+)"
_CELL_WORD_ID_RE = re.compile(rf"\b(?:card|cell):?\s+`?({_HEX8})`?({_SPAN_TAIL})?")
_TICKED_REF_RE = re.compile(r"`((?:card|cell|concept):[^`\s]+)`")
_BARE_SPAN_RE = re.compile(rf"(?<![\w:/#@-])({_HEX8})({_SPAN_TAIL})")
_WORD_ID_RE = re.compile(rf"\b(notebook|sentence|section|paragraph|comment)\s+`?{_HEX8}`?(?!\w)")
_BARE_ID_RE = re.compile(rf"(?:\b(?P<prep>in|at|of|from|on|to|see|by|per)\s+)?(?<![\w:/#@.-])`?(?P<id>{_HEX8})`?(?![\w-])")
_EMPTY_BRACKETS_RE = re.compile(r"\s*[(\[]\s*[)\]]")
_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([,;:!?]|\.(?!\w))")  # not before a period that starts a word (".yardopts")


def readable_ids(text: str, *, cells: set[str] | None = None, doc_ids: set[str] | None = None) -> str:
    """A model's text with every workspace id in the chip grammar or removed: a card mention becomes card:<id>, a
    document id is dropped, a notebook or sentence id reads as its word."""
    out = _TICKED_REF_RE.sub(r"\1", text or "")
    out = _CELL_WORD_ID_RE.sub(lambda m: f"card:{m.group(1)}{m.group(2) or ''}", out)
    out = _BARE_SPAN_RE.sub(r"card:\1\2", out)
    out = _WORD_ID_RE.sub(lambda m: f"the {m.group(1)}", out)
    if cells or doc_ids:
        known_cells = cells or set()
        known_doc = doc_ids or set()

        def bare(m: "re.Match[str]") -> str:
            i = m.group("id")
            if i in known_cells:
                return f"{m.group('prep')} card:{i}" if m.group("prep") else f"card:{i}"
            if i in known_doc:
                return ""
            return m.group(0)

        out = _BARE_ID_RE.sub(bare, out)
        out = _EMPTY_BRACKETS_RE.sub("", out)
        out = _SPACE_BEFORE_PUNCT_RE.sub(r"\1", out)
        out = re.sub(r"[ \t]{2,}", " ", out).strip()
    return out


def workspace_cell_ids(c: str) -> set[str]:
    ws = config.workspace_dir(c)
    out: set[str] = set()
    for info in notebook.list_notebooks(ws):
        nb = notebook.read_notebook(ws, info["id"])
        for cell in (nb or {}).get("cells") or []:
            if isinstance(cell, dict) and cell.get("id"):
                out.add(str(cell["id"]))
    return out


def _emit(c: str, event: dict[str, Any]) -> None:
    """A document's record on the stream, which the report checks also read: a save that changed text reruns the shown
    checks on that document (checks.on_report)."""
    try:
        investigation.emit(c, investigation.MAIN, event)
    except Exception:  # noqa: BLE001
        log.debug("report event not emitted for %s/%s", c, event.get("slug"), exc_info=True)
    try:
        from . import checks  # noqa: PLC0415 — checks imports this module

        checks.on_report(c, event)
    except Exception:  # noqa: BLE001 — a check that does not rerun is no reason to fail a save
        log.exception("%s: the checks did not hear the save of %s", c, event.get("slug"))


# --------------------------------------------------------------------------- routes: types


def _fallback_slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40]
    return s if SLUG_RE.match(s) and s not in RESERVED else f"type-{_stamp()[-6:]}"


class TypeBody(BaseModel):
    slug: str | None = None
    name: str
    description: str = ""
    renderer: str
    prompt: str
    rubric: str = ""
    forked_from: str | None = None
    model_config = ConfigDict(populate_by_name=True)
    doc_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    component: str | None = None
    # a page: renderer custom with the page schema and no component
    page: bool = False


class TypeEdit(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str | None = None
    description: str | None = None
    renderer: str | None = None
    prompt: str | None = None
    rubric: str | None = None
    doc_schema: dict[str, Any] | None = Field(default=None, alias="schema")
    component: str | None = None


def _ws_ok(c: str) -> None:
    config.workspace_dir(c)


@router.get("/ws/{c}/report-types")
async def list_types_route(c: str) -> list[dict[str, Any]]:
    _ws_ok(c)
    return list_types(c)


@router.post("/ws/{c}/report-types", status_code=201)
async def create_type_route(c: str, body: TypeBody) -> dict[str, Any]:
    _ws_ok(c)
    slug = body.slug or _fallback_slug(body.name)
    if body.page:
        if body.renderer != "custom":
            raise HTTPException(400, "a page has the custom renderer")
        return write_type(c, slug, name=body.name, description=body.description, renderer="custom", prompt=body.prompt,
                          rubric=body.rubric, forked_from=body.forked_from, create=True, page=True)
    if body.renderer == "custom":
        expand_schema(body.doc_schema)
    return write_type(c, slug, name=body.name, description=body.description, renderer=body.renderer,
                      prompt=body.prompt, rubric=body.rubric, schema=body.doc_schema, component=body.component,
                      forked_from=body.forked_from, create=True)


class NewDocBody(BaseModel):
    kind: str
    name: str | None = None
    brief: str = ""


@router.get("/ws/{c}/report-types/presets")
async def presets_route(c: str) -> list[dict[str, Any]]:
    """The presets + New offers, each {id, name, description, renderer, prompt}."""
    _ws_ok(c)
    return presets(c)


@router.post("/ws/{c}/report-types/new", status_code=201)
async def new_document_route(c: str, body: NewDocBody) -> dict[str, Any]:
    """+ New: a document of a preset, a page, or one of the analyst's own from a name and a brief
    (create_document_type)."""
    _ws_ok(c)
    return create_document_type(c, body.kind, name=body.name, brief=body.brief)


@router.get("/ws/{c}/report-types/{slug}")
async def get_type_route(c: str, slug: str) -> dict[str, Any]:
    _ws_ok(c)
    return _require_type(c, _check_slug(slug, custom=False))


@router.put("/ws/{c}/report-types/{slug}")
async def update_type_route(c: str, slug: str, body: TypeEdit) -> dict[str, Any]:
    _ws_ok(c)
    slug = _check_slug(slug, custom=False)
    if slug in BUILTIN_SLUGS:
        raise HTTPException(409, f"{slug!r} is built in and read-only; save a copy under another slug to edit it")
    t = _require_type(c, slug)
    renderer = body.renderer if body.renderer is not None else t["renderer"]
    if renderer == "custom" and not t.get("page"):
        expand_schema(body.doc_schema if body.doc_schema is not None else t.get("schema_source"))
    out = write_type(c, slug, name=body.name if body.name is not None else t["name"],
                     description=body.description if body.description is not None else t["description"],
                     renderer=renderer,
                     prompt=body.prompt if body.prompt is not None else t["prompt"],
                     rubric=body.rubric if body.rubric is not None else t["rubric"],
                     schema=body.doc_schema, component=body.component)
    _emit(c, {"type": "report", "slug": slug, "status": "renamed" if out["name"] != t["name"] else "type-edited", "by": ANALYST})
    return out


@router.delete("/ws/{c}/report-types/{slug}")
async def delete_type_route(c: str, slug: str) -> dict[str, Any]:
    _ws_ok(c)
    slug = _check_slug(slug, custom=False)
    if slug in BUILTIN_SLUGS:
        raise HTTPException(409, f"{slug!r} is built in")
    delete_type(c, slug)
    _emit(c, {"type": "report", "slug": slug, "status": "deleted", "by": ANALYST})
    return {"ok": True}


# --------------------------------------------------------------------------- routes: documents


class CommentBody(BaseModel):
    sentence_id: str
    text: str
    kind: str | None = None


class SentenceEdit(BaseModel):
    text: str | None = None
    locked: bool | None = None  # the lock on the sentence's block, its paragraph (set_block_lock)


class UnitEdit(BaseModel):
    heading: str | None = None
    locked: bool | None = None  # the lock on the section's heading (set_block_lock)


class TitleEdit(BaseModel):
    title: str | None = None
    locked: bool | None = None  # the lock on the title (set_block_lock)


class FrameSectionBody(BaseModel):
    heading: str


class FrameParagraphBody(BaseModel):
    text: str


class FrameFigureBody(BaseModel):
    cell: str
    caption: str | None = None
    after: str | None = None


class FrameUnitEdit(BaseModel):
    text: str | None = None
    heading: str | None = None
    caption: str | None = None


@router.get("/ws/{c}/investigations/{inv_id}/types")
async def types_state_route(c: str, inv_id: str) -> dict[str, Any]:
    """Per type: whether a document exists, its generation and its open comments, and whether a frame is laid out or a
    write is running."""
    investigation.inv_dir(c, inv_id)
    out: dict[str, Any] = {}
    for t in list_types(c):
        doc = read_doc(c, inv_id, t["slug"])
        if doc:
            entry = {"exists": True, "generation": doc.get("generation"), "generated_at": doc.get("generated_at"),
                     "renderer": doc.get("renderer") or t["renderer"], "title": doc.get("title"),
                     "open_comments": len(anchored_open_comments(doc))}
        else:
            frame = read_frame(c, inv_id, t["slug"])
            entry = {"exists": False, "renderer": t["renderer"], "frame": bool(frame and units(frame))}
        entry["name"] = t["name"]
        if t.get("page"):
            entry["page"] = True
        if inv_id == investigation.MAIN and write_pending(c, t["slug"]) is not None:
            entry["status"] = "generating"
        out[t["slug"]] = entry
    return out


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}")
async def get_doc_route(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    _require_type(c, _check_slug(slug, custom=False))
    return _load(c, inv_id, slug)


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/versions")
async def versions_route(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    from . import versions  # noqa: PLC0415

    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    _require_type(c, slug)
    return versions.history(c, inv_id, slug, _load(c, inv_id, slug))


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/versions/{n}")
async def version_route(c: str, inv_id: str, slug: str, n: int) -> dict[str, Any]:
    from . import versions  # noqa: PLC0415

    from . import story  # noqa: PLC0415

    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    _require_type(c, slug)
    return story.upgrade(copy.deepcopy(versions.document_of(c, inv_id, slug, n, _load(c, inv_id, slug))))


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/versions/{n}/revisions/{i}")
async def revision_route(c: str, inv_id: str, slug: str, n: int, i: int) -> dict[str, Any]:
    """Revision `i` of generation `n`: an earlier save of the writer run that wrote it (versions.revision_of)."""
    from . import story, versions  # noqa: PLC0415

    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    _require_type(c, slug)
    return story.upgrade(copy.deepcopy(versions.revision_of(c, inv_id, slug, n, i, _load(c, inv_id, slug))))


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/export")
async def export_route(c: str, inv_id: str, slug: str, appendix: bool = False) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    _require_type(c, slug)
    _load(c, inv_id, slug)
    return await asyncio.to_thread(export_markdown, c, inv_id, slug, appendix=appendix)


# --------------------------------------------------------------------------- routes: the frame


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/frame")
async def frame_route(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    """The document when one is written, else the frame."""
    investigation.inv_dir(c, inv_id)
    return frame_or_doc(c, inv_id, _check_slug(slug, custom=False))[0]


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/frame/sections", status_code=201)
async def frame_section_route(c: str, inv_id: str, slug: str, body: FrameSectionBody) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    return add_section(c, _check_slug(slug, custom=False), body.heading, inv_id=inv_id)


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/frame/sections/{sid}/paragraphs", status_code=201)
async def frame_paragraph_route(c: str, inv_id: str, slug: str, sid: str, body: FrameParagraphBody) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    return add_paragraph(c, _check_slug(slug, custom=False), sid, body.text, inv_id=inv_id)


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/frame/sections/{sid}/figures", status_code=201)
async def frame_figure_route(c: str, inv_id: str, slug: str, sid: str, body: FrameFigureBody) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    return add_frame_figure(c, _check_slug(slug, custom=False), sid, body.cell, body.caption, body.after, inv_id=inv_id)


@router.delete("/ws/{c}/investigations/{inv_id}/types/{slug}/frame/units/{uid}")
async def frame_delete_route(c: str, inv_id: str, slug: str, uid: str) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    return delete_unit(c, _check_slug(slug, custom=False), uid, inv_id=inv_id)


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/frame/units/{uid}")
async def frame_edit_route(c: str, inv_id: str, slug: str, uid: str, body: FrameUnitEdit) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    return edit_unit(c, _check_slug(slug, custom=False), uid, text=body.text, heading=body.heading, caption=body.caption, inv_id=inv_id)


# --------------------------------------------------------------------------- routes: the editor's blocks
# The report editor (frontend/src/report) saves the whole document as an ordered list of blocks, each carrying the id of
# the unit it was built from. Blocks are reconciled into the written document, else the frame: kept ids keep their
# records, an unchanged or respelled sentence keeps its id, refs and tags, new or changed text is the analyst's and not
# locked, and a unit the editor dropped goes with its comments.

BLOCK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_KEY_MARKS_RE = re.compile(r"[*_`\\]")


class BlockIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    type: str
    text: str | None = None
    level: int | None = None
    cell: str | None = None
    caption: str | None = None
    marker: str | None = None
    children: list[BlockIn] | None = None


class BlocksBody(BaseModel):
    title: str = ""
    blocks: list[BlockIn] = Field(default_factory=list)
    # the saving tab's token, echoed in the `edited` event so that tab can tell its own save from another's
    client: str | None = Field(default=None, max_length=64)


BlockIn.model_rebuild()


def flat_blocks(blocks: list[BlockIn]) -> list[BlockIn]:
    """The blocks depth first: nesting has no stored form, so a child follows its parent."""
    out: list[BlockIn] = []
    for b in blocks:
        out.append(b)
        if b.children:
            out.extend(flat_blocks(b.children))
    return out


def sentence_key(text: Any) -> str:
    """What two spellings of one sentence share: a citation reduced to what it shows, emphasis and code marks dropped,
    whitespace collapsed, case folded. The editor's round trip may respell `__x__` as `**x**` or a bare ref as `[[ref]]`."""

    def shown(m: re.Match[str]) -> str:
        inner = m.group(0)[2:-2]
        return (inner.split("|", 1)[0] if "|" in inner else inner).strip()

    t = refs._BRACKETS.sub(shown, str(text or ""))
    return " ".join(_KEY_MARKS_RE.sub("", t).split()).lower()


def _index_units(target: dict[str, Any]) -> tuple[dict, dict, dict, dict, dict[str, str]]:
    """The target's sections, paragraphs, sentences and figures by id, and the paragraph id holding each sentence."""
    secs: dict[str, dict[str, Any]] = {}
    paras: dict[str, dict[str, Any]] = {}
    sents: dict[str, dict[str, Any]] = {}
    figs: dict[str, dict[str, Any]] = {}
    para_of: dict[str, str] = {}
    for u in units(target):
        secs[str(u.get("id"))] = u
        for p in u.get("paragraphs") or []:
            if not isinstance(p, dict):
                continue
            paras[str(p.get("id"))] = p
            for x in p.get("sentences") or []:
                if isinstance(x, dict):
                    sents[str(x.get("id"))] = x
                    para_of[str(x.get("id"))] = str(p.get("id"))
        for f in u.get("figures") or []:
            if isinstance(f, dict):
                figs[str(f.get("id"))] = f
    return secs, paras, sents, figs, para_of


def _flat_units(text: str) -> list[str]:
    from . import report_format  # noqa: PLC0415

    return [u["text"] for para in report_format.segment_units(text) for u in para]


def apply_blocks(target: dict[str, Any], title: str, blocks: list[BlockIn], valid: _Refs, *, is_doc: bool,
                 by: str = ANALYST) -> dict[str, Any]:
    """Reconcile the editor's blocks into `target` (a document or a frame); mutates and returns it."""
    if isinstance(target.get("slides"), list) or isinstance(target.get("beats"), list):
        raise HTTPException(409, "the editor saves a document with sections")
    from . import report_format  # noqa: PLC0415

    secs, paras, sents, figs, para_of = _index_units(target)
    used = _ids(target)
    taken: set[str] = set()
    changed: set[str] = set()
    # an anchor of a comment that names no sentence or heading any more -> the one that holds its text: a sentence given
    # another id, the heading a paragraph became, the first sentence of the paragraph a heading became
    renamed: dict[str, str] = {}

    def was_locked(bid: str) -> bool:
        """Whether the stored unit the block `bid` was built from is locked: the section of a heading, a paragraph, or
        the paragraph that holds a list item's sentence. A block whose type changed keeps that lock."""
        if bid in secs:
            return secs[bid].get("locked") is True
        rec = paras.get(bid) or paras.get(para_of.get(bid, ""))
        return rec is not None and rec.get("locked") is True

    def claim(preferred: str | None) -> str:
        pid = preferred if preferred and BLOCK_ID_RE.match(preferred) and preferred not in taken else None
        if pid is None:
            pid = _new_id(used)
        used.add(pid)
        taken.add(pid)
        return pid

    def new_sentence(sid: str | None, text: str, bullet: str | None) -> dict[str, Any]:
        rec: dict[str, Any] = {"id": claim(sid), "text": text, "refs": valid.clean(refs.extract_refs(text), text), "tags": [], "tag_notes": {}}
        if bullet:
            rec["bullet"] = bullet
        _pinned(rec, by)
        return rec

    def kept_sentence(old: dict[str, Any], text: str, bullet: str | None, sid: str | None = None) -> dict[str, Any]:
        rec = copy.deepcopy(old)
        rec["id"] = claim(sid or str(old.get("id")))
        if rec["id"] != str(old.get("id")):
            renamed.setdefault(str(old.get("id")), rec["id"])
        rec["text"] = text
        if bullet:
            rec["bullet"] = bullet
        else:
            rec.pop("bullet", None)
        return rec

    def same(old: dict[str, Any], text: str) -> bool:
        return _collapse(old.get("text")) == text or sentence_key(old.get("text")) == sentence_key(text)

    def moved(text: str) -> dict[str, Any] | None:
        """An unclaimed sentence anywhere in the document with exactly this text: one the analyst moved, not rewrote."""
        return next((x for x in sents.values() if str(x.get("id")) not in taken and _collapse(x.get("text")) == text), None)

    def match_prose(texts: list[str], pool: list[dict[str, Any]], own: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """The sentences of a paragraph's text, each keeping the record of an unclaimed sentence of `pool` with its
        text; `own` is a list item's sentence whose id its paragraph has just taken, which it keeps under a new id."""
        out: list[dict[str, Any]] = []
        left = [x for x in pool if str(x.get("id")) not in taken or x is own]
        for text in texts:
            hit = next((x for x in left if _collapse(x.get("text")) == text), None) or next((x for x in left if same(x, text)), None) or moved(text)
            if hit is not None:
                if hit in left:
                    left.remove(hit)
                out.append(kept_sentence(hit, text, None))
            else:
                out.append(new_sentence(None, text, None))
        return out

    sections: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    last_pid: str | None = None

    def open_section(sec: dict[str, Any]) -> dict[str, Any]:
        nonlocal cur, last_pid
        cur = sec
        last_pid = None
        sections.append(sec)
        return sec

    def section() -> dict[str, Any]:
        return cur if cur is not None else open_section(_pinned({"id": claim(None), "heading": "", "role": "custom", "paragraphs": [], "figures": []}, by))

    i = 0
    while i < len(blocks):
        b = blocks[i]
        i += 1
        if b.type == "heading":
            heading = _collapse(b.text)
            old = secs.get(b.id) if b.id not in taken else None
            if old is not None:
                sec = copy.deepcopy(old)
                sec["id"] = claim(b.id)
                sec["paragraphs"], sec["figures"] = [], []
                _put_text(sec, "heading", heading)
            else:
                source = b.id not in taken
                sec = _pinned({"id": claim(b.id), "heading": heading, "role": "custom", "paragraphs": [], "figures": []}, by)
                # a paragraph or a list item made a heading keeps its lock, and the comments on its sentences move to it
                if source and was_locked(b.id):
                    sec["locked"] = True
                for x in (paras[b.id].get("sentences") or []) if source and b.id in paras else []:
                    if isinstance(x, dict):
                        renamed.setdefault(str(x.get("id")), sec["id"])
            if _level(b.level) > 2:
                sec["level"] = _level(b.level)
            else:
                sec.pop("level", None)
            open_section(sec)
        elif b.type == "paragraph":
            text = _collapse(b.text)
            if not text:
                continue
            sec = section()
            old_p = paras.get(b.id) if b.id not in taken else None
            source = old_p is None and b.id not in taken
            item = sents.get(b.id) if source else None
            pool = [x for x in old_p.get("sentences") or [] if isinstance(x, dict)] if old_p else ([item] if item else [])
            pid = claim(b.id)
            para = copy.deepcopy(old_p) if old_p else _pinned({"id": pid}, by)
            para["id"] = pid
            para["sentences"] = match_prose(_flat_units(text), pool, own=item)
            # a heading or a list item made a paragraph keeps its lock, and a comment on the heading moves to its text
            if source and was_locked(b.id):
                para["locked"] = True
            if source and b.id in secs and para["sentences"]:
                renamed.setdefault(b.id, str(para["sentences"][0]["id"]))
            sec["paragraphs"].append(para)
            last_pid = pid
        elif b.type == "bullet":
            run = [b]
            while i < len(blocks) and blocks[i].type == "bullet" and (blocks[i].marker == "1.") == (b.marker == "1."):
                run.append(blocks[i])
                i += 1
            items = [(blk, " ".join(_flat_units(_collapse(blk.text)))) for blk in run]
            items = [(blk, t) for blk, t in items if t]
            if not items:
                continue
            sec = section()
            marker = report_format.NUMBER if b.marker == "1." else report_format.BULLET
            old_pid = next((para_of[blk.id] for blk, _ in items if blk.id in para_of and blk.id not in taken), None)
            old_p = paras.get(old_pid) if old_pid else None
            pid = claim(old_pid if old_p and old_pid not in taken else None)
            spare = [x for x in (old_p or {}).get("sentences") or [] if isinstance(x, dict) and str(x.get("id")) not in {blk.id for blk, _ in items}]
            sentences: list[dict[str, Any]] = []
            locked_source = False
            for blk, text in items:
                # a paragraph or a heading made a list item: its lock goes to the list, its comments to the item
                source = blk.id not in taken and blk.id not in sents
                old = sents.get(blk.id) if blk.id not in taken else None
                if old is not None and same(old, text):
                    sentences.append(kept_sentence(old, text, marker))
                elif (hit := next((x for x in spare if str(x.get("id")) not in taken and same(x, text)), None)
                      or moved(text)) is not None:
                    if hit in spare:
                        spare.remove(hit)
                    sentences.append(kept_sentence(hit, text, marker, sid=blk.id))
                else:
                    if old is not None:
                        changed.add(blk.id)
                    sentences.append(new_sentence(blk.id, text, marker))
                if source:
                    locked_source = locked_source or was_locked(blk.id)
                    for x in (paras[blk.id].get("sentences") or []) if blk.id in paras else []:
                        if isinstance(x, dict):
                            renamed.setdefault(str(x.get("id")), str(sentences[-1]["id"]))
            para = copy.deepcopy(old_p) if old_p else _pinned({"id": pid}, by)
            para["id"] = pid
            para["sentences"] = sentences
            if locked_source:
                para["locked"] = True
            sec["paragraphs"].append(para)
            last_pid = pid
        elif b.type == "figure":
            sec = section()
            old_f = figs.get(b.id) if b.id not in taken else None
            cid = cite.strip_card(b.cell)
            caption = _collapse(b.caption)
            if old_f is not None:
                fig = copy.deepcopy(old_f)
                fig["id"] = claim(b.id)
                if cid and cid in valid.cells and cite.canon(str(fig.get("cell") or "")) != f"card:{cid}":
                    fig["cell"] = f"card:{cid}"
                    for k in ("make", "kind", "status", "note"):
                        fig.pop(k, None)
                if caption:
                    fig["caption"] = caption
            else:
                if not cid or cid not in valid.cells:
                    continue
                fig = _pinned({"id": claim(b.id), "cell": f"card:{cid}", "caption": caption or valid.artifacts.get(cid) or ""}, by)
            fig["after_paragraph"] = last_pid
            if last_pid is None:
                fig["lead"] = True
            else:
                fig.pop("lead", None)
            sec["figures"].append(fig)
        else:
            raise HTTPException(400, f"unknown block type {b.type!r}")

    target["sections"] = sections
    title = _collapse(title)
    if title != _collapse(target.get("title")):
        if is_doc:
            _put_text(target, "title", title, history="title_history", edited_by="title_edited_by")
            if target.get("renderer") == "document":
                target["title_ok"] = _title_ok(title)
        else:
            target["title"] = title
    if "comments" in target or is_doc:
        heads = {str(s["id"]) for s in sections}
        anchors = heads | {str(x.get("id")) for s in sections for p in s["paragraphs"] for x in p.get("sentences") or []
                           if isinstance(x, dict)}
        kept: list[dict[str, Any]] = []
        for cm in target.get("comments") or []:
            if not isinstance(cm, dict):
                continue
            at = str(cm.get("sentence_id") or "")
            if at not in anchors and renamed.get(at) in anchors:
                at = cm["sentence_id"] = renamed[at]
                if at in heads:
                    cm.pop("paragraph", None)
            if at not in taken:
                continue
            if str(cm.get("sentence_id")) in changed:
                settle_carried_comment(cm, anchored=False, generation=int(target.get("generation") or 0))
            kept.append(cm)
        target["comments"] = kept
    if is_doc:
        v = target.get("verifier")
        if isinstance(v, dict) and isinstance(v.get("sections"), dict):
            v["sections"] = {k: s for k, s in v["sections"].items() if k in taken}
    return target


def save_blocks(c: str, inv_id: str, slug: str, title: str, blocks: list[BlockIn], *, by: str = ANALYST) -> dict[str, Any]:
    """The editor's blocks into the written document, else into the frame (created when there is something to keep). A
    slides
    type not written yet takes blocks too; a written deck, a story and a page do not."""
    renderer = _require_type(c, slug)["renderer"]
    if renderer not in ("document", "slides"):
        raise HTTPException(409, "the editor saves a document with sections")
    target, is_doc = frame_or_doc(c, inv_id, slug)
    apply_blocks(target, title, flat_blocks(blocks), _Refs(c), is_doc=is_doc, by=by)
    if is_doc:
        write_doc(c, inv_id, slug, target)
    elif target.get("sections") or _collapse(target.get("title")) or read_frame(c, inv_id, slug) is not None:
        write_frame(c, inv_id, slug, target)
    return target


# edit_document's `block_type`: the editor's block each kind is, as (type, level or list marker)
BLOCK_TYPES: dict[str, tuple[str, int | str | None]] = {"heading": ("heading", 2), "subheading": ("heading", 3),
                                                          "text": ("paragraph", None), "bullets": ("bullet", "-"),
                                                          "numbers": ("bullet", "1.")}


def editor_blocks(doc: dict[str, Any]) -> list[BlockIn]:
    """A document with sections as the editor's blocks (frontend/src/report/model.ts blocksFromDoc): per section its
    heading,
    lead figures, paragraphs (a bullet block per item for a list) with the figures placed after each, then other
    figures."""
    from . import report_format  # noqa: PLC0415

    def figure(f: dict[str, Any]) -> BlockIn:
        return BlockIn(id=str(f.get("id")), type="figure", cell=str(f.get("cell") or ""), caption=str(f.get("caption") or ""))

    out: list[BlockIn] = []
    for u in units(doc):
        if _collapse(u.get("heading")):
            out.append(BlockIn(id=str(u["id"]), type="heading", text=str(u["heading"]), level=_level(u.get("level"))))
        figs = [f for f in u.get("figures") or [] if isinstance(f, dict)]
        paras = [p for p in u.get("paragraphs") or [] if isinstance(p, dict)]
        out += [figure(f) for f in figs if f.get("lead")]
        for p in paras:
            items = [x for x in p.get("sentences") or [] if isinstance(x, dict)]
            if items and all(x.get("bullet") for x in items):
                out += [BlockIn(id=str(x["id"]), type="bullet", text=str(x.get("text") or "").strip(),
                                marker="1." if x.get("bullet") == report_format.NUMBER else "-") for x in items]
            else:
                text = " ".join(t for x in items if (t := str(x.get("text") or "").strip()))
                out.append(BlockIn(id=str(p["id"]), type="paragraph", text=text))
            out += [figure(f) for f in figs if str(f.get("after_paragraph") or "") == str(p["id"])]
        known = {str(p["id"]) for p in paras}
        out += [figure(f) for f in figs if not f.get("lead") and str(f.get("after_paragraph") or "") not in known]
    return out


def set_block_type(c: str, slug: str, uid: str, kind: str, actor: str, *, inv_id: str = investigation.MAIN) -> dict[str, Any]:
    """The block `uid` names turned into a heading, subheading, text or list, its text kept, by reconciling the changed
    blocks
    back (apply_blocks), so the unit keeps its lock and comments. Returns {ref, reverted}."""
    if kind not in BLOCK_TYPES:
        raise HTTPException(400, f"no block type {kind!r}; the types are {', '.join(BLOCK_TYPES)}")
    if _require_type(c, slug)["renderer"] != "document":
        raise HTTPException(400, f"the {slug} has no blocks to turn into headings or lists")
    doc = _load(c, inv_id, slug)
    if uid == TITLE_BLOCK:
        raise HTTPException(400, "the title stays the title")
    before = copy.deepcopy(doc)
    blocks = editor_blocks(doc)
    hit = [b for b in blocks if b.id == uid]
    if not hit:
        para = find_paragraph(doc, uid)
        holder = para[1] if para else next((p for u in units(doc) for p in u.get("paragraphs") or [] if isinstance(p, dict)
                                            and any(str(x.get("id")) == uid for x in p.get("sentences") or [] if isinstance(x, dict))),
                                           None)
        ids = ({str(holder["id"]), *(str(x.get("id")) for x in holder.get("sentences") or [] if isinstance(x, dict))}
               if holder else set())
        hit = [b for b in blocks if b.id in ids]
    if not hit:
        raise HTTPException(404, f"no heading, paragraph or list item {uid}")
    if any(b.type == "figure" for b in hit):
        raise HTTPException(400, "a figure has no text to turn into a heading or a list")
    to, extra = BLOCK_TYPES[kind]
    for b in hit:
        b.type, b.level, b.marker = to, extra if to == "heading" else None, extra if to == "bullet" else None
    apply_blocks(doc, str(doc.get("title") or ""), blocks, _Refs(c), is_doc=True, by=actor)
    reverted = _save_edit(c, inv_id, slug, doc, before, actor)
    first = hit[0].id
    ref = f"report:{slug}#{'p' if to == 'paragraph' else ''}{first}"
    _emit(c, {"type": "report", "slug": slug, "status": "rewritten", "span": ref})
    return {"ref": ref, "reverted": reverted}


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/blocks")
async def blocks_route(c: str, inv_id: str, slug: str, body: BlocksBody) -> dict[str, Any]:
    """The editor's save: the whole document as blocks, reconciled into the written document or the frame. The stream
    carries `report {slug, status: edited, client}` so the saving tab can tell its own save from another's."""
    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    _require_type(c, slug)
    target = save_blocks(c, inv_id, slug, body.title, body.blocks)
    if inv_id == investigation.MAIN:
        ev: dict[str, Any] = {"type": "report", "slug": slug, "status": "edited", "by": ANALYST}
        if body.client:
            ev["client"] = body.client
        _emit(c, ev)
    return target


# --------------------------------------------------------------------------- routes: the deck's editor
# The deck's editor (frontend/src/report/Deck.tsx) saves the whole deck as its slides in order, each line carrying the
# id
# of the sentence it showed. Kept slides keep their records, unchanged or respelled lines keep their sentences, changed
# lines keep the id and become the analyst's (a deck has no locks), and what the editor dropped goes with its comments.


class SlideLineIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    text: str = ""


class SlideFigureIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    cell: str
    caption: str | None = None


class SlideQuoteIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    text: str = ""
    speaker: str = ""


class SlideIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    heading: str = ""
    layout: str | None = None
    format: dict[str, Any] | None = None
    lines: list[SlideLineIn] = Field(default_factory=list)
    bullets: bool = True
    quote: SlideQuoteIn | None = None
    figures: list[SlideFigureIn] = Field(default_factory=list)
    notes: str = ""


class DeckBody(BaseModel):
    title: str = ""
    slides: list[SlideIn] = Field(default_factory=list)
    client: str | None = Field(default=None, max_length=64)  # as BlocksBody's


def apply_deck(target: dict[str, Any], title: str, slides_in: list[SlideIn], valid: _Refs, *, is_doc: bool,
               by: str = ANALYST) -> dict[str, Any]:
    """Reconcile the deck editor's slides into `target`, a deck or its frame (section note above); mutates and returns
    it. 409 for a target that is not a deck."""
    from . import report_format  # noqa: PLC0415

    if not isinstance(target.get("slides"), list):
        raise HTTPException(409, "only a deck takes slides")
    old_slides = {str(s.get("id")): s for s in target["slides"] if isinstance(s, dict)}
    old_sents = {str(x.get("id")): x for s in old_slides.values() for x in s.get("sentences") or [] if isinstance(x, dict)}
    old_figs = {str(f.get("id")): f for s in old_slides.values() for f in slides.figures_of(s)}
    used = _ids(target)
    taken: set[str] = set()
    changed: set[str] = set()

    def claim(preferred: str | None) -> str:
        pid = preferred if preferred and BLOCK_ID_RE.match(preferred) and preferred not in taken else None
        if pid is None:
            pid = _new_id(used)
        used.add(pid)
        taken.add(pid)
        return pid

    def same(old: dict[str, Any], text: str) -> bool:
        return _collapse(old.get("text")) == text or sentence_key(old.get("text")) == sentence_key(text)

    def record(text: str, bullet: str | None, line_id: str, pool: list[dict[str, Any]]) -> dict[str, Any]:
        """The sentence a line holds: the one it showed when unchanged, else one of the slide's with the same text,
        else one moved from another slide, else its own sentence changed (keeping the id), else a new one."""
        old = old_sents.get(line_id) if line_id and line_id not in taken else None
        hit = old if old is not None and same(old, text) else None
        hit = hit or next((x for x in pool if str(x.get("id")) not in taken and same(x, text)), None) or \
            next((x for x in old_sents.values() if str(x.get("id")) not in taken and _collapse(x.get("text")) == text), None)
        if hit is not None:
            rec = copy.deepcopy(hit)
            rec["id"] = claim(str(hit.get("id")))
            rec["text"] = text
        else:
            # a changed line keeps its sentence's id, and a new one the id the editor minted for it
            keep = old is not None
            rec = {"id": claim(line_id if line_id and (keep or line_id not in old_sents) else None), "text": text,
                   "refs": valid.clean(refs.extract_refs(text), text), "tags": [], "tag_notes": {}}
            _pinned(rec, by)
            if keep:
                changed.add(rec["id"])
        if bullet:
            rec["bullet"] = bullet
        else:
            rec.pop("bullet", None)
        rec.pop("quote", None)
        rec.pop("speaker", None)
        return rec

    out: list[dict[str, Any]] = []
    for s in slides_in:
        old = old_slides.get(s.id) if s.id not in taken else None
        slide = copy.deepcopy(old) if old is not None else _pinned({}, by)
        slide["id"] = claim(s.id if old is not None or BLOCK_ID_RE.match(s.id or "") else None)
        heading = _collapse(s.heading)
        if old is not None:
            _put_text(slide, "heading", heading)
        else:
            slide["heading"] = heading
        pool = [x for x in (old or {}).get("sentences") or [] if isinstance(x, dict)]
        sentences: list[dict[str, Any]] = []
        if s.quote is not None and _collapse(s.quote.text):
            q = record(_collapse(s.quote.text), None, s.quote.id, pool)
            q["quote"] = True
            if _collapse(s.quote.speaker):
                q["speaker"] = _collapse(s.quote.speaker)
            sentences.append(q)
        for line in s.lines:
            text = _collapse(line.text)
            if not text:
                continue
            parts = [text] if s.bullets else [u["text"] for para in report_format.segment_units(text) for u in para] or [text]
            for i, part in enumerate(parts):
                sentences.append(record(part, report_format.BULLET if s.bullets else None, line.id if i == 0 else "", pool))
        figures: list[dict[str, Any]] = []
        for f in s.figures:
            if len(figures) >= slides.MAX_FIGURES:
                break
            cid = slides.card_id(valid, f.cell)
            prev = old_figs.get(f.id) if f.id and f.id not in taken else None
            if prev is not None and (cid is None or cite.canon(str(prev.get("cell") or "")) == f"card:{cid}"):
                fig = copy.deepcopy(prev)
                fig["id"] = claim(f.id)
            elif cid is not None:
                fid = claim(f.id if f.id and f.id not in old_figs else None)
                fig = _pinned({"id": fid, "cell": f"card:{cid}", "caption": valid.artifacts.get(cid, "")}, by)
            else:
                continue
            if f.caption is not None and _collapse(f.caption):
                fig["caption"] = _collapse(f.caption)
            figures.append(fig)
        slide["sentences"], slide["figures"] = sentences, figures
        slide.pop("figure", None)
        slide["notes"] = _collapse(s.notes)
        layout = slides.layout_name(s.layout)
        if layout:
            slide["layout"] = layout
        else:
            slide.pop("layout", None)
        fmt = slides.clean_format(s.format)
        if fmt:
            slide["format"] = fmt
        else:
            slide.pop("format", None)
        out.append(slide)
    target["slides"] = out
    title = _collapse(title)
    if title != _collapse(target.get("title")):
        if is_doc:
            _put_text(target, "title", title, history="title_history", edited_by="title_edited_by")
        else:
            target["title"] = title
    if "comments" in target or is_doc:
        kept: list[dict[str, Any]] = []
        for cm in target.get("comments") or []:
            if not isinstance(cm, dict) or str(cm.get("sentence_id") or "") not in taken:
                continue
            if str(cm.get("sentence_id")) in changed:
                settle_carried_comment(cm, anchored=False, generation=int(target.get("generation") or 0))
            kept.append(cm)
        target["comments"] = kept
    return target


def save_deck(c: str, inv_id: str, slug: str, title: str, slides_in: list[SlideIn], *, by: str = ANALYST) -> dict[str, Any]:
    """The deck editor's slides into the written deck, else into its frame (apply_deck). 409 for a type that is not a
    deck."""
    if _require_type(c, slug)["renderer"] != "slides":
        raise HTTPException(409, "only a deck takes slides")
    target, is_doc = frame_or_doc(c, inv_id, slug)
    apply_deck(target, title, slides_in, _Refs(c), is_doc=is_doc, by=by)
    if is_doc:
        write_doc(c, inv_id, slug, target)
    else:
        write_frame(c, inv_id, slug, target)
    return target


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/deck")
async def deck_route(c: str, inv_id: str, slug: str, body: DeckBody) -> dict[str, Any]:
    """The deck editor's save: the whole deck as its slides (save_deck). The stream carries `report {slug, status:
    edited,
    client}`, as the report editor's save does."""
    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    target = save_deck(c, inv_id, slug, body.title, body.slides)
    if inv_id == investigation.MAIN:
        ev: dict[str, Any] = {"type": "report", "slug": slug, "status": "edited", "by": ANALYST}
        if body.client:
            ev["client"] = body.client
        _emit(c, ev)
    return target


# --------------------------------------------------------------------------- routes: the story's editor


def save_story(c: str, inv_id: str, slug: str, body: Any, *, by: str = ANALYST) -> dict[str, Any]:
    """The story editor's sections into the written story, else into its frame (story.apply_story). 409 for a type that
    is not a story."""
    from . import story  # noqa: PLC0415

    if _require_type(c, slug)["renderer"] != "story":
        raise HTTPException(409, "only a story takes the story editor's sections")
    target, is_doc = frame_or_doc(c, inv_id, slug)
    story.apply_story(target, body.title, body.sections, _Refs(c), is_doc=is_doc, by=by)
    if is_doc:
        write_doc(c, inv_id, slug, target)
    else:
        write_frame(c, inv_id, slug, target)
    return target


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/story")
async def story_route(c: str, inv_id: str, slug: str, body: StoryBody) -> dict[str, Any]:
    """The story editor's save: the whole story as its sections (save_story). The stream carries `report {slug,
    status: edited, client}`, as the report editor's save does."""
    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    target = save_story(c, inv_id, slug, body)
    if inv_id == investigation.MAIN:
        ev: dict[str, Any] = {"type": "report", "slug": slug, "status": "edited", "by": ANALYST}
        if body.client:
            ev["client"] = body.client
        _emit(c, ev)
    return target


class LockBody(BaseModel):
    locked: bool
    client: str | None = Field(default=None, max_length=64)  # as BlocksBody's


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/locks/{block}")
async def lock_route(c: str, inv_id: str, slug: str, block: str, body: LockBody) -> dict[str, Any]:
    """The analyst's lock on one block of the editor, set or cleared (set_block_lock); `block` is the block's id in the
    editor, `title` for the title. Returns the document or the frame, and the stream carries `report {slug, status:
    edited, client}` as a save does."""
    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    if not BLOCK_ID_RE.match(block):
        raise HTTPException(404, f"no block {block}")
    target = set_block_lock(c, inv_id, slug, block, body.locked)
    if inv_id == investigation.MAIN:
        ev: dict[str, Any] = {"type": "report", "slug": slug, "status": "edited", "by": ANALYST}
        if body.client:
            ev["client"] = body.client
        _emit(c, ev)
    return target


# --------------------------------------------------------------------------- routes: comments and edits, any type


def _any_doc(c: str, inv_id: str, slug: str) -> tuple[str, dict[str, Any]]:
    slug = _check_slug(slug, custom=False)
    _require_type(c, slug)
    return slug, _load(c, inv_id, slug)


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/comments", status_code=201)
async def post_comment(c: str, inv_id: str, slug: str, body: CommentBody) -> dict[str, Any]:
    """Store the analyst's comment on a sentence or a unit heading; returns the comment."""
    investigation.inv_dir(c, inv_id)
    slug, doc = _any_doc(c, inv_id, slug)
    sid = (body.sentence_id or "").strip()
    text = _collapse(body.text)
    if not text:
        raise HTTPException(400, "comment text is required")
    find_target(doc, sid)
    comment: dict[str, Any] = {"id": _new_id(_ids(doc)), "sentence_id": sid, "text": text, "author": ANALYST, "ts": _now(), "status": "open"}
    kind = _collapse(body.kind).lower()
    if kind:
        comment["kind"] = kind
    doc["comments"].append(comment)
    write_doc(c, inv_id, slug, doc)
    return comment


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/comments/{cid}/dismiss")
async def dismiss(c: str, inv_id: str, slug: str, cid: str) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    slug, doc = _any_doc(c, inv_id, slug)
    _find_comment(doc, cid)["status"] = "dismissed"
    write_doc(c, inv_id, slug, doc)
    return doc


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/comments/{cid}/reopen")
async def reopen(c: str, inv_id: str, slug: str, cid: str) -> dict[str, Any]:
    investigation.inv_dir(c, inv_id)
    slug, doc = _any_doc(c, inv_id, slug)
    if reopen_comment(_find_comment(doc, cid)):
        write_doc(c, inv_id, slug, doc)
    return doc


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/sentences/{sid}")
async def edit_sentence(c: str, inv_id: str, slug: str, sid: str, body: SentenceEdit) -> dict[str, Any]:
    """The analyst's edit of a sentence, which does not lock it; an explicit `locked` sets or clears the lock on its
    block, the paragraph (set_block_lock)."""
    investigation.inv_dir(c, inv_id)
    slug, doc = _any_doc(c, inv_id, slug)
    target = find_target(doc, sid)
    if target["kind"] != "sentence":
        raise HTTPException(404, f"no such sentence: {sid}")
    sentence = target["sentence"]
    if body.text is not None:
        text = _collapse(body.text)
        if not text:
            raise HTTPException(400, "sentence text is required")
        if _put_text(sentence, "text", text, valid=_Refs(c)):
            write_doc(c, inv_id, slug, doc)
    return set_block_lock(c, inv_id, slug, sid, body.locked) if body.locked is not None else doc


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/units/{uid}")
async def edit_heading(c: str, inv_id: str, slug: str, uid: str, body: UnitEdit) -> dict[str, Any]:
    """The analyst's edit of a heading, which does not lock it; an explicit `locked` sets or clears its lock
    (set_block_lock)."""
    investigation.inv_dir(c, inv_id)
    slug, doc = _any_doc(c, inv_id, slug)
    target = find_target(doc, uid)
    if target["kind"] != "heading":
        raise HTTPException(404, f"no such heading: {uid}")
    unit = target["unit"]
    if body.heading is not None:
        heading = _collapse(body.heading)
        if not heading:
            raise HTTPException(400, "heading is required")
        if _put_text(unit, "heading", heading):
            write_doc(c, inv_id, slug, doc)
    return set_block_lock(c, inv_id, slug, uid, body.locked) if body.locked is not None else doc


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/title")
async def edit_title(c: str, inv_id: str, slug: str, body: TitleEdit) -> dict[str, Any]:
    """The analyst's edit of the title, which does not lock it; an explicit `locked` sets or clears its lock
    (set_block_lock)."""
    investigation.inv_dir(c, inv_id)
    slug, doc = _any_doc(c, inv_id, slug)
    if body.title is not None:
        title = _collapse(body.title)
        if not title:
            raise HTTPException(400, "title is required")
        if _put_text(doc, "title", title, history="title_history", edited_by="title_edited_by"):
            if doc.get("renderer") == "document":
                doc["title_ok"] = _title_ok(title)
            write_doc(c, inv_id, slug, doc)
    return set_block_lock(c, inv_id, slug, TITLE_BLOCK, body.locked) if body.locked is not None else doc


# --------------------------------------------------------------------------- routes: a page's html


class HtmlBody(BaseModel):
    html: str = Field(max_length=HTML_MAX)


def set_html(c: str, inv_id: str, slug: str, html: str, t: dict[str, Any]) -> dict[str, Any]:
    """The analyst's html on a page: written into the page's document, which is created (generation 0, the analyst's)
    when the writer has not produced one yet. Mutates the stored document and returns it."""
    doc = read_doc(c, inv_id, slug)
    if doc is None:
        doc = {"id": slug, "type": slug, "renderer": "custom", "title": t.get("name") or slug, "claims": [],
               "generation": 0, "source": ANALYST, "comments": []}
    doc["html"] = html.replace("\r\n", "\n")
    doc["html_edited_by"] = ANALYST
    doc["html_edited_at"] = _now()
    write_doc(c, inv_id, slug, doc)
    return doc


@router.get("/ws/{c}/investigations/{inv_id}/types/{slug}/film")
async def film_route(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    """A video's film as its frame loads it (video.film_document). 409 on a type that is not a video."""
    from . import video  # noqa: PLC0415

    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    if _require_type(c, slug)["renderer"] != "video":
        raise HTTPException(409, f"{slug!r} is not a video")
    return {"html": video.film_document(_load(c, inv_id, slug))}


@router.put("/ws/{c}/investigations/{inv_id}/types/{slug}/html")
async def put_html_route(c: str, inv_id: str, slug: str, body: HtmlBody) -> dict[str, Any]:
    """The page's code drawer save: the whole html. 409 on a type that is not a page."""
    investigation.inv_dir(c, inv_id)
    slug = _check_slug(slug, custom=False)
    t = _require_type(c, slug)
    if not t.get("page"):
        raise HTTPException(409, f"{slug!r} is not a page")
    doc = set_html(c, inv_id, slug, body.html, t)
    if inv_id == investigation.MAIN:
        _emit(c, {"type": "report", "slug": slug, "status": "edited", "by": ANALYST})
    return doc


_listen()
