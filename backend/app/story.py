"""The story: its sections as the writer writes them in markdown, as the Report tab's story editor saves them
(apply_story), and as a chat edit inserts into them (insert_blocks, set_card); a legacy story read in the current
shape
(upgrade); and the graphic schema of a custom type's `$graphic` slots.

A stored story is {title, sections}, each section {id, heading, paragraphs, figures} with `card`: right (default),
left, full or none. A paragraph is text, a list, or one of BLOCK_KINDS under `kind`. A figure is the section's card
(`role: main`, with its step, step_of), a card among the blocks, or a picture of a card (`role: image`). The first
section may have no heading: it opens the story."""
from __future__ import annotations

import copy
import hashlib
import logging
import re
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import cite, refs, report_format
from .report import FIXED, _Refs, _collapse, _new_id, _put_text, settle_carried_comment
from .schemas import CELL_REF

log = logging.getLogger("thimble.story")

KINDS = ("timeline", "bar", "line", "table", "quote", "cell", "callout", "you_draw_it", "custom", "code")
LIMITATIONS_HEADING = FIXED["caveats"]
SIDES = ("right", "left", "full", "none")
BLOCK_KINDS = ("headline", "quote", "callout", "divider")
MAIN, IMAGE = "main", "image"
# the editor's block types: a text block holds prose (or a list typed as one), bullets one item per line
BLOCK_TYPES = ("text", "bullets", *BLOCK_KINDS, "card", "image")

# The graphics a custom type's `$graphic` slot may hold; the writer writes a figure as a card instead, so nothing here
# makes one.
_xy = {"type": ["string", "number", "null"]}
_rows = {"type": "array", "items": {"type": "object", "additionalProperties": {"type": ["string", "number", "boolean", "null"]}}}
_GRAPHIC = {
    "type": "object",
    "properties": {
        "kind": {"enum": list(KINDS)},
        "title": {"type": "string"},
        "caption": {"type": "string", "description": "One sentence: what to take from the graphic."},
        "refs": {"type": "array", "items": {"type": "string", "minLength": 1},
                 "description": "The cards (card:<id>, or spans) the graphic's numbers come from."},
        "events": {"type": "array", "items": {"type": "object", "properties": {
            "time": {"type": "string"}, "actor": {"type": "string"}, "label": {"type": "string", "minLength": 1},
            "ref": {"type": "string"}}, "required": ["time", "label"], "additionalProperties": False}},
        "data": {"type": "object", "properties": {"cell": {"type": "string", "pattern": CELL_REF}, "rows": _rows},
                 "additionalProperties": False, "description": "{cell} to read a table-bearing card's rows as they are, or {rows} copied from the material."},
        "x": {"type": "string"}, "y": {"type": "string"}, "series": {"type": "string"},
        "annotations": {"type": "array", "items": {"type": "object", "properties": {
            "x": _xy, "y": _xy, "text": {"type": "string", "minLength": 1}, "ref": {"type": "string"}},
            "required": ["text"], "additionalProperties": False}},
        "columns": {"type": "array", "items": {"type": "string"}},
        "highlight": {"type": "array", "items": {"type": "object", "properties": {"col": {"type": "string"}, "row": {"type": "string"}},
                                                 "required": ["col", "row"], "additionalProperties": False}},
        "ref": {"type": "string", "description": "quote: the record ref; callout: the span that shows the value."},
        "speaker": {"type": "string"},
        "cell": {"type": "string", "pattern": CELL_REF},
        "value": {"type": "string", "description": "callout: the number exactly as the card shows it."},
        "label": {"type": "string"},
        "question": {"type": "string"},
        "mode": {"enum": ["value", "series"]},
        "unit": {"type": "string"},
        "range": {"type": "object", "properties": {"min": {"type": "number"}, "max": {"type": "number"}},
                  "required": ["min", "max"], "additionalProperties": False},
        "truth": {"type": "object", "properties": {"value": {"type": "string"}, "ref": {"type": "string"}},
                  "required": ["value", "ref"], "additionalProperties": False},
        "reveal_after": _xy,
        "reveal_text": {"type": "string"},
        "spec": {"type": "object", "description": "custom: a complete Vega-Lite v5 specification with inline data."},
        "code": {"type": "string", "description": "code: Python ending in a DataFrame or an Altair chart."},
    },
    "required": ["kind"],
    "additionalProperties": False,
}


def side_of(sec: dict[str, Any]) -> str:
    s = sec.get("card")
    return s if s in SIDES else "right"


def main_figure(sec: dict[str, Any]) -> dict[str, Any] | None:
    return next((f for f in sec.get("figures") or [] if isinstance(f, dict) and f.get("role") == MAIN), None)


def is_story(doc: dict[str, Any] | None) -> bool:
    return bool(doc) and doc.get("renderer") == "story"


# --------------------------------------------------------------------------- a section written as markdown
# A section's text is read block by block: `---` a divider, `### ` a headline, `>` lines a quote (a last `> — Name` its
# speaker), `Callout` (or `Stakes`) a callout, `Card: left|right|full|none` the card's side, anything else text, `- `
# lines a list. The first figure line is the section's card unless its card is none or its step is `image`.

_DIVIDER_RE = re.compile(r"^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$")
_SUB_RE = re.compile(r"^#{3,6}[ \t]+(.+?)[ \t]*#*[ \t]*$")
_CARD_RE = re.compile(r"^\**card\**\s*[:.\-–—]\**\s*(right|left|full|none)\b\W*$", re.I)
_CALLOUT_RE = re.compile(r"^\**(?:callout|stakes)\**\s*[:.\-–—]\**\s*", re.I)
_SPEAKER_RE = re.compile(r"^\s*(?:—|–|--)\s*(.+?)\s*$")
_LIMITS_RE = re.compile(r"^(?:limitations?|what the data cannot (?:settle|say|tell))\b", re.I)


def _chunk_blocks(chunk: str) -> list[dict[str, Any]]:
    rows = [r for r in chunk.split("\n") if r.strip()]
    if not rows:
        return []
    if len(rows) == 1 and (m := _CARD_RE.match(rows[0].strip())):
        return [{"type": "card-side", "side": m.group(1).lower()}]
    if len(rows) == 1 and _DIVIDER_RE.match(rows[0].strip()):
        return [{"type": "divider"}]
    if all(r.lstrip().startswith(">") for r in rows):
        texts = [r.lstrip()[1:].strip() for r in rows]
        speaker = ""
        if len(texts) > 1 and (m := _SPEAKER_RE.match(texts[-1])):
            speaker, texts = m.group(1), texts[:-1]
        return [{"type": "quote", "text": " ".join(t for t in texts if t), "speaker": speaker}]
    if m := _SUB_RE.match(rows[0].strip()):
        return [{"type": "headline", "text": m.group(1)}] + _chunk_blocks("\n".join(rows[1:]))
    if m := _CALLOUT_RE.match(chunk.strip()):
        return [{"type": "callout", "text": chunk.strip()[m.end():].strip()}]
    return [{"type": "text", "text": chunk.strip()}]


def section_blocks(body: str, figures: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """(the blocks of a section's markdown in order, the side a `Card:` line set or None): each block {type, text,
    speaker} or, for a figure line, {type: figure, cell, caption, step}, placed after the block its `after_paragraph`
    counts (report_types._md_sections)."""
    chunks = [q.strip() for q in re.split(r"\n\s*\n", str(body or "").strip()) if q.strip()]
    figs = [f for f in figures or [] if isinstance(f, dict)]
    out: list[dict[str, Any]] = []
    side: str | None = None

    def figures_after(k: int | None) -> None:
        for f in figs:
            at = f.get("after_paragraph") or 0
            if at == k or (k is None and at > len(chunks)):
                out.append({"type": "figure", "cell": f.get("cell"), "caption": f.get("caption") or "", "step": f.get("step") or ""})

    figures_after(0)
    for k, chunk in enumerate(chunks, 1):
        for b in _chunk_blocks(chunk):
            if b["type"] == "card-side":
                side = b["side"]
            else:
                out.append(b)
        figures_after(k)
    figures_after(None)
    return out, side


def _card_of(valid: _Refs, raw: Any) -> str | None:
    from .slides import card_id  # noqa: PLC0415 — slides imports report, as this module does

    return card_id(valid, raw)


def _text_paragraphs(text: str, valid: _Refs, used: set[str]) -> list[dict[str, Any]]:
    """Text as paragraphs of sentence records, a list as one paragraph whose sentences carry their bullet."""
    return [{"id": _new_id(used), "sentences": report_format.records_of(para, valid, used)}
            for para in report_format.segment_units(text)]


def block_records(blocks: list[dict[str, Any]], valid: _Refs, used: set[str], *, side: str, after: str | None = None,
                  has_main: bool = False) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(paragraphs, figures) of parsed blocks: the first figure is the section's card when it has none and shows one,
    figures
    of cards the canvas lacks are left out, and a block figure follows the paragraph before it."""
    paras: list[dict[str, Any]] = []
    figs: list[dict[str, Any]] = []
    last = after
    for b in blocks:
        kind = b.get("type")
        if kind == "figure":
            cid = _card_of(valid, b.get("cell"))
            if cid is None:
                log.info("story: figure on %r left out: no such card", b.get("cell"))
                continue
            step = _collapse(b.get("step"))
            image = step.lower() == IMAGE
            rec = {"id": _new_id(used), "cell": f"card:{cid}", "caption": _collapse(b.get("caption")) or valid.artifacts.get(cid, "")}
            if not has_main and not image and side != "none":
                has_main = True
                figs.append({**rec, "after_paragraph": None, "role": MAIN, **step_of(step)})
            else:
                figs.append({**rec, "after_paragraph": last, **({"role": IMAGE} if image else {})})
            continue
        if kind == "divider":
            p: dict[str, Any] = {"id": _new_id(used), "kind": "divider", "sentences": []}
            paras.append(p)
            last = p["id"]
            continue
        if kind == "text":
            for p in _text_paragraphs(str(b.get("text") or ""), valid, used):
                paras.append(p)
                last = p["id"]
            continue
        sentences = [x for x in report_format.sentence_units(str(b.get("text") or ""), valid, used)]
        for x in sentences:
            x.pop("bullet", None)
        if not sentences:
            continue
        p = {"id": _new_id(used), "kind": kind, "sentences": sentences}
        if kind == "quote" and _collapse(b.get("speaker")):
            p["speaker"] = _collapse(b.get("speaker"))
        paras.append(p)
        last = p["id"]
    return paras, figs


# --------------------------------------------------------------------------- the writer's story made into the stored story


def normalize_outline(raw: dict[str, Any], valid: _Refs, slug: str) -> dict[str, Any]:
    """The stored story from parse_markdown's {title, sections}: blocks as paragraphs and figures, a headed section with
    no
    card taking the first chart- or table-bearing card its text cites. 502 when no section has a sentence."""
    used: set[str] = set()
    sections: list[dict[str, Any]] = []
    for s in raw.get("sections") if isinstance(raw.get("sections"), list) else []:
        if not isinstance(s, dict):
            continue
        heading = _collapse(s.get("heading"))
        blocks, side = section_blocks(str(s.get("body") or ""), s.get("figures"))
        paras, figs = block_records(blocks, valid, used, side=side or "right")
        if not paras and not figs and not heading:
            continue
        sec: dict[str, Any] = {"id": _new_id(used), "heading": heading, "paragraphs": paras, "figures": figs}
        if side:
            sec["card"] = side
        if heading and side != "none" and main_figure(sec) is None and not _LIMITS_RE.match(heading):
            back = fallback_cell(sec, valid)
            if back:
                figs.insert(0, {"id": _new_id(used), "cell": f"card:{back}", "caption": valid.artifacts.get(back, ""),
                                "after_paragraph": None, "role": MAIN})
        sections.append(sec)
    if not any(p.get("sentences") for sec in sections for p in sec["paragraphs"]):
        raise HTTPException(502, "the story has no section with a sentence")
    return {"id": slug, "type": slug, "renderer": "story", "title": _collapse(raw.get("title")) or "Story", "sections": sections}


_CALLOUT_STEP_RE = re.compile(r"^callout\s*[:\-–—]\s*(.+)$", re.I)
MAX_HIGHLIGHT = 12


def step_of(raw: Any) -> dict[str, Any]:
    """A section's step on its card, from its figure line's quoted title: `callout: <text>` calls out a number or
    phrase,
    anything else names the rows, events or nodes to highlight, comma-separated."""
    s = _collapse(raw)
    if not s or s.lower() == IMAGE:
        return {}
    m = _CALLOUT_STEP_RE.match(s)
    if m:
        return {"callout": m.group(1).strip()}
    terms = [t.strip() for t in re.split(r"[,;]", s) if t.strip()]
    return {"highlight": terms[:MAX_HIGHLIGHT]} if terms else {}


def section_cells(sec: dict[str, Any]) -> list[str]:
    """The cards the section's sentences cite, in order."""
    out: list[str] = []
    for p in sec.get("paragraphs") or []:
        for x in p.get("sentences") or [] if isinstance(p, dict) else []:
            for r in list(x.get("refs") or []) + refs.extract_refs(str(x.get("text") or "")):
                try:
                    parsed = refs.parse_ref(str(r))
                except ValueError:
                    continue
                if parsed.get("kind") == "cell" and str(parsed["cell_id"]) not in out:
                    out.append(str(parsed["cell_id"]))
    return out


def fallback_cell(sec: dict[str, Any], valid: _Refs) -> str | None:
    """The first card the section cites that bears a chart or a table."""
    return next((cid for cid in section_cells(sec) if valid.artifact_id(f"card:{cid}")), None)


def carry_cards(doc: dict[str, Any], *olds: dict[str, Any] | None) -> None:
    """Where each section's card stands, carried from the previous generation (or the frame) to a section the writer
    gave no `Card:` line, by the heading it matches best."""
    earlier = [u for old in olds if old for u in old.get("sections") or [] if isinstance(u, dict) and u.get("card") in SIDES]
    for sec in doc.get("sections") or []:
        if not isinstance(sec, dict) or "card" in sec or not _collapse(sec.get("heading")):
            continue
        want = report_format.tokens(sec.get("heading"))
        best, score = None, 0.0
        for u in earlier:
            toks = report_format.tokens(u.get("heading"))
            s = len(want & toks) / len(want | toks) if want and toks else 0.0
            if s > score:
                best, score = u, s
        if best is not None and score >= 0.5:
            sec["card"] = best["card"]


def place_figure(sec: dict[str, Any], rec: dict[str, Any]) -> None:
    """A figure put into a section from elsewhere (a pinned figure the writer left out, a figure added to the frame):
    the section's card when it has none, else a card after its last paragraph."""
    paras = [p for p in sec.get("paragraphs") or [] if isinstance(p, dict)]
    if main_figure(sec) is None and side_of(sec) != "none":
        rec.update(role=MAIN, after_paragraph=None)
    else:
        rec.pop("role", None)
        rec["after_paragraph"] = str(paras[-1]["id"]) if paras else None
    sec.setdefault("figures", []).append(rec)


# --------------------------------------------------------------------------- a legacy story read in the current shape


def _did(doc_id: str, key: str, used: set[str]) -> str:
    """A stable id for a record a legacy story lacks, so a comment or thread can anchor on it before the story is saved.
    """
    n = 0
    while True:
        i = hashlib.sha1(f"{doc_id}:{key}:{n}".encode()).hexdigest()[:8]
        if i not in used:
            used.add(i)
            return i
        n += 1


def _sentence(i: str, text: str) -> dict[str, Any]:
    return {"id": i, "text": text, "refs": [], "tags": [], "tag_notes": {}}


def _limitations_text(doc: dict[str, Any]) -> str:
    lim = doc.get("limitations")
    if isinstance(lim, str) and lim.strip():
        return _collapse(lim)
    old = doc.get("not_covered")
    if isinstance(old, list):
        return " ".join(_collapse(x) for x in old if isinstance(x, str) and x.strip())
    return ""


def upgrade(doc: dict[str, Any]) -> dict[str, Any]:
    """A stored story read in the current shape, in place: a legacy answer, beats, stakes and limitations as sections
    and
    callouts; a frame's figures, the first of a section as its card."""
    if not is_story(doc):
        return doc
    if isinstance(doc.get("beats"), list):
        did = str(doc.get("id") or doc.get("type") or "story")
        used = {str(x.get("id")) for x in _all_records(doc)}
        sections: list[dict[str, Any]] = []
        answer = doc.get("answer") if isinstance(doc.get("answer"), dict) else None
        if answer and _collapse(answer.get("text")):
            sections.append({"id": _did(did, "lede", used), "heading": "", "card": "right",
                             "paragraphs": [{"id": _did(did, "lede-p", used), "sentences": [answer]}], "figures": []})
        for b in doc["beats"]:
            if not isinstance(b, dict):
                continue
            sec = {k: v for k, v in b.items() if k not in ("sentences", "stakes", "figures", "figure_note")}
            bid = str(b.get("id"))
            paras: list[dict[str, Any]] = []
            sentences = [x for x in b.get("sentences") or [] if isinstance(x, dict)]
            if sentences:
                paras.append({"id": _did(did, f"{bid}-p", used), "sentences": sentences})
            stakes = _collapse(b.get("stakes"))
            if stakes:
                paras.append({"id": _did(did, f"{bid}-stakes", used), "kind": "callout",
                              "sentences": [_sentence(_did(did, f"{bid}-stakes-s", used), stakes)]})
            figs: list[dict[str, Any]] = []
            for f in b.get("figures") or []:
                if not isinstance(f, dict):
                    continue
                if not figs and (f.get("cell") or f.get("make")):
                    figs.append({**f, "after_paragraph": None, "role": MAIN})
                else:
                    figs.append({**f, "after_paragraph": str(paras[0]["id"]) if paras else None})
            sec.update(card="right", paragraphs=paras, figures=figs)
            sections.append(sec)
        lim = _limitations_text(doc)
        if lim:
            sections.append({"id": _did(did, "limitations", used), "heading": LIMITATIONS_HEADING, "card": "right",
                             "paragraphs": [{"id": _did(did, "limitations-p", used),
                                             "sentences": [_sentence(_did(did, "limitations-s", used), lim)]}],
                             "figures": []})
        for k in ("beats", "answer", "limitations", "not_covered"):
            doc.pop(k, None)
        doc["sections"] = sections
    secs = [s for s in doc.get("sections") or [] if isinstance(s, dict)]
    if doc.get("frame") and not any("card" in s for s in secs):
        for s in secs:
            figs = [f for f in s.get("figures") or [] if isinstance(f, dict)]
            first = next((f for f in figs if not f.get("after_paragraph")), figs[0] if figs else None)
            if first is not None and main_figure(s) is None:
                first["role"] = MAIN
                first["after_paragraph"] = None
            s["card"] = "right"
    return doc


def _all_records(node: Any):
    if isinstance(node, dict):
        if isinstance(node.get("id"), str):
            yield node
        for v in node.values():
            yield from _all_records(v)
    elif isinstance(node, list):
        for v in node:
            yield from _all_records(v)


# --------------------------------------------------------------------------- the story as its reader and its writer read it


def section_mark(sec: dict[str, Any]) -> str:
    """read_ref's mark on a section's line: where its card stands, when not at the right."""
    side = side_of(sec)
    return "" if side == "right" else f" · card {side}"


def paragraph_mark(p: dict[str, Any]) -> str:
    kind = p.get("kind")
    if kind not in BLOCK_KINDS:
        return ""
    who = _collapse(p.get("speaker")) if kind == "quote" else ""
    return f" · {kind}" + (f" by {who}" if who else "")


def figure_mark(f: dict[str, Any]) -> str:
    role = f.get("role")
    return " · the section's card" if role == MAIN else " · image" if role == IMAGE else ""


# --------------------------------------------------------------------------- an edit from the chat


def insert_blocks(unit: dict[str, Any], para: dict[str, Any] | None, text: str, valid: _Refs,
                        used: set[str], actor: str) -> dict[str, Any]:
    """The blocks `text` holds, in the story's markdown, put into `unit` after paragraph `para` (at its start with
    none).
    Mutates `unit`; returns {ref, new sentences, side}."""
    from .report_types import _MD_FIGURE_RE  # noqa: PLC0415 — report_types imports this module

    lines: list[str] = []
    figures: list[dict[str, Any]] = []
    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        if m := _MD_FIGURE_RE.match(line.strip()):
            done = [q for q in re.split(r"\n\s*\n", "\n".join(lines).strip()) if q.strip()]
            fig: dict[str, Any] = {"cell": m.group(2), "caption": m.group(1).strip(), "after_paragraph": len(done) or None}
            if m.group(3):
                fig["step"] = m.group(3).strip()
            figures.append(fig)
            continue
        lines.append(line)
    blocks, side = section_blocks("\n".join(lines), figures)
    if side:
        unit["card"] = side
    at = str(para["id"]) if para is not None else None
    paras, figs = block_records(blocks, valid, used, side=side_of(unit), after=at, has_main=main_figure(unit) is not None)
    if not paras and not figs and not side:
        raise HTTPException(400, "the new passage has no sentence and no card")
    held = unit.setdefault("paragraphs", [])
    start = next((i + 1 for i, p in enumerate(held) if p is para), 0)
    held[start:start] = paras
    unit.setdefault("figures", []).extend(figs)
    for rec in [*paras, *figs]:
        rec["by"] = actor
    ref = f"p{paras[0]['id']}" if paras else str(figs[0]["id"]) if figs else str(unit["id"])
    return {"ref": ref, "sentences": [x for p in paras for x in p.get("sentences") or []], "side": side}


def set_card(doc: dict[str, Any], unit: dict[str, Any], side: str) -> str:
    """Where `unit`'s card stands; 400 for a side that is none of SIDES."""
    s = str(side or "").strip().lower()
    if s not in SIDES:
        raise HTTPException(400, f"no card side {side!r}; a section's card stands {', '.join(SIDES)}")
    unit["card"] = s
    return s


# --------------------------------------------------------------------------- the story editor's save
# The story editor (frontend/src/report/StoryEditor.tsx) saves the whole story as its sections, each block with the id
# of
# the record it came from. Kept ids keep their records and locks; an unchanged or respelled sentence keeps its id, refs
# and tags; a rewritten sentence in an old one's place keeps its id; new text is the analyst's; and what the editor
# dropped goes with its comments.

class StoryFigureIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    cell: str = ""
    caption: str | None = None


class StoryBlockIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    type: str
    text: str = ""
    speaker: str = ""
    cell: str = ""
    caption: str | None = None


class StorySectionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = ""
    heading: str = ""
    card: str = "right"
    main: StoryFigureIn | None = None
    blocks: list[StoryBlockIn] = Field(default_factory=list)


class StoryBody(BaseModel):
    title: str = ""
    sections: list[StorySectionIn] = Field(default_factory=list)
    client: str | None = Field(default=None, max_length=64)  # as report_types.BlocksBody's


def _key(text: Any) -> str:
    from .report_types import sentence_key  # noqa: PLC0415

    return sentence_key(text)


def _units_of(block: StoryBlockIn) -> list[tuple[str, str | None]]:
    """(text, bullet) of each sentence a block's text holds: a text block's sentences (a list typed into it keeps its
    bullets), a bullets block's lines each one item, a headline, quote or callout's sentences without bullets."""
    if block.type == "bullets":
        items = [re.sub(r"^\s*(?:[-*+•]|\d{1,2}[.)])\s+", "", line) for line in block.text.split("\n")]
        return [(t, report_format.BULLET) for t in (_collapse(x) for x in items) if t]
    units = [u for para in report_format.segment_units(block.text) for u in para]
    if block.type == "text":
        return [(u["text"], u.get("bullet")) for u in units]
    return [(u["text"], None) for u in units]


def apply_story(target: dict[str, Any], title: str, sections_in: list[StorySectionIn], valid: _Refs, *, is_doc: bool,
                by: str) -> dict[str, Any]:
    """Reconcile the story editor's sections into `target`, a story or its frame (section note above); mutates and
    returns it. 409 for a target that is not a story."""
    from .report_types import BLOCK_ID_RE, _ids, _index_units, _pinned  # noqa: PLC0415

    if not is_story(target):
        raise HTTPException(409, "only a story takes the story editor's sections")
    secs, paras, sents, figs, _ = _index_units(target)
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
        return _collapse(old.get("text")) == text or _key(old.get("text")) == _key(text)

    def sentences_for(units: list[tuple[str, str | None]], pool: list[dict[str, Any]]) -> list[dict[str, Any]]:
        left = [x for x in pool if str(x.get("id")) not in taken]

        def drop(x: dict[str, Any]) -> bool:
            k = next((i for i, y in enumerate(left) if y is x), None)
            if k is not None:
                del left[k]
            return k is not None

        hits: list[dict[str, Any] | None] = []
        for text, _ in units:
            hit = next((x for x in left if _collapse(x.get("text")) == text), None) or next((x for x in left if same(x, text)), None)
            hit = hit or next((x for x in sents.values() if str(x.get("id")) not in taken and _collapse(x.get("text")) == text), None)
            if hit is not None:
                drop(hit)
                taken.add(str(hit.get("id")))
            hits.append(hit)
        out: list[dict[str, Any]] = []
        for i, ((text, bullet), hit) in enumerate(zip(units, hits)):
            if hit is not None:
                rec = copy.deepcopy(hit)
                rec["text"] = text
            else:
                spot = pool[i] if i < len(pool) and drop(pool[i]) else None
                if spot is not None:
                    changed.add(str(spot.get("id")))
                rec = _pinned({"id": claim(str(spot.get("id")) if spot is not None else None), "text": text,
                               "refs": valid.clean(refs.extract_refs(text), text), "tags": [], "tag_notes": {}}, by)
            if bullet:
                rec["bullet"] = bullet
            else:
                rec.pop("bullet", None)
            out.append(rec)
        return out

    def figure(f: StoryBlockIn | StoryFigureIn) -> dict[str, Any] | None:
        cid = _card_of(valid, f.cell)
        old = figs.get(f.id) if f.id and f.id not in taken else None
        if old is not None and (cid is None or cite.canon(str(old.get("cell") or "")) == f"card:{cid}"):
            rec = copy.deepcopy(old)
            rec["id"] = claim(f.id)
        elif cid is not None:
            rec = _pinned({"id": claim(f.id if f.id and f.id not in figs else None), "cell": f"card:{cid}",
                           "caption": valid.artifacts.get(cid, "")}, by)
        else:
            return None
        if f.caption is not None:
            rec["caption"] = _collapse(f.caption)
        return rec

    out: list[dict[str, Any]] = []
    for s in sections_in:
        old_s = secs.get(s.id) if s.id and s.id not in taken else None
        sec = copy.deepcopy(old_s) if old_s is not None else _pinned({}, by)
        sec["id"] = claim(s.id if old_s is not None or BLOCK_ID_RE.match(s.id or "") else None)
        heading = _collapse(s.heading)
        if old_s is not None:
            _put_text(sec, "heading", heading)
        else:
            sec["heading"] = heading
        sec.pop("role", None)
        sec["card"] = s.card if s.card in SIDES else "right"
        section_paras: list[dict[str, Any]] = []
        section_figs: list[dict[str, Any]] = []
        if s.main is not None and (main := figure(s.main)) is not None:
            for k in ("lead",):
                main.pop(k, None)
            main.update(role=MAIN, after_paragraph=None)
            old_cell = cite.canon(str((figs.get(s.main.id) or {}).get("cell") or ""))
            if old_cell != cite.canon(str(main.get("cell") or "")):
                main.pop("highlight", None)
                main.pop("callout", None)
            section_figs.append(main)
        last: str | None = None
        for b in s.blocks:
            if b.type in ("card", "image"):
                rec = figure(b)
                if rec is None:
                    continue
                rec["after_paragraph"] = last
                for k in ("lead", "highlight", "callout"):
                    rec.pop(k, None)
                if b.type == "image":
                    rec["role"] = IMAGE
                else:
                    rec.pop("role", None)
                section_figs.append(rec)
                continue
            if b.type not in BLOCK_TYPES:
                raise HTTPException(400, f"unknown block type {b.type!r}")
            units = [] if b.type == "divider" else _units_of(b)
            if b.type != "divider" and not units:
                continue
            old_p = paras.get(b.id) if b.id and b.id not in taken else None
            pool = [x for x in (old_p or {}).get("sentences") or [] if isinstance(x, dict)]
            pid = claim(b.id if old_p is not None or b.id not in sents else None)
            para = copy.deepcopy(old_p) if old_p is not None else _pinned({}, by)
            para["id"] = pid
            para["sentences"] = sentences_for(units, pool)
            if b.type in BLOCK_KINDS:
                para["kind"] = b.type
            else:
                para.pop("kind", None)
            if b.type == "quote" and _collapse(b.speaker):
                para["speaker"] = _collapse(b.speaker)
            else:
                para.pop("speaker", None)
            section_paras.append(para)
            last = pid
        sec["paragraphs"], sec["figures"] = section_paras, section_figs
        out.append(sec)
    target["sections"] = out
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
