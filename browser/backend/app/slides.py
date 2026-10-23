"""The slide deck: a deck written as markdown made into the stored deck, the layouts a slide takes, and the analyst's
deck as the Report tab's editor saves it (report_types.save_deck).

A slide is {id, heading, layout, sentences, figures, notes, format}. Its layout arranges its cards on a 16:9 slide:
`title`, `text`, `figure` (lines beside one or two cards), `card`, `figures` (two to four cards in a row or a 2x2
grid)
and `quote`. Lines are sentence records, so checks, comments and the filter read slides as they read the report.
`format` holds the figure's side and width, the number of card `slots` and `grid`; a card past the slots stays on the
slide unseen. A slide without a stored layout takes the one its cards call for (layout_of). PRESETS name a layout
with
its slots, grid and bullets."""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import HTTPException

from . import refs, report_format
from .report import _Refs, _collapse, _new_id
from .schemas import TAGS

log = logging.getLogger("thimble.slides")

DOC_ID = "slides"
LAYOUTS = ("title", "text", "figure", "card", "figures", "quote")
MAX_FIGURES = 4  # the most cards a slide holds
SLOTS = {"figure": (1, 2), "card": (1, 1), "figures": (2, MAX_FIGURES)}  # the card slots a layout shows, least and most
SIDES = ("left", "right")
WIDTH_MIN, WIDTH_MAX, WIDTH_DEFAULT = 30, 70, 50  # the figure's share of the slide's width, in percent


def card_id(valid: _Refs, raw: Any) -> str | None:
    """The id of the card `raw` names (card:<id>, cell:<id>, a span of it, or the bare id) when the canvas has it."""
    s = str(raw or "").strip().strip("[]")
    try:
        p = refs.parse_ref(s)
        cid = str(p["cell_id"]) if p.get("kind") == "cell" else None
    except ValueError:
        cid = s or None
    return cid if cid and cid in valid.cells else None


def figures_of(slide: dict[str, Any]) -> list[dict[str, Any]]:
    """The slide's figures in order: a legacy single `figure` first, then `figures`, each once."""
    out: list[dict[str, Any]] = []
    for f in [slide.get("figure"), *(slide.get("figures") or [])]:
        if isinstance(f, dict) and (f.get("cell") or f.get("make")) and all(f.get("id") != g.get("id") for g in out):
            out.append(f)
    return out


def body_sentences(slide: dict[str, Any]) -> list[dict[str, Any]]:
    """The slide's lines, its quote left out."""
    return [x for x in slide.get("sentences") or [] if isinstance(x, dict) and not x.get("quote")]


def quote_of(slide: dict[str, Any]) -> dict[str, Any] | None:
    return next((x for x in slide.get("sentences") or [] if isinstance(x, dict) and x.get("quote")), None)


def layout_of(slide: dict[str, Any]) -> str:
    """The slide's stored layout, else the one its cells call for: a quote alone, several figures, one figure, a heading
    alone (a title or section slide), else the heading and its lines."""
    if slide.get("layout") in LAYOUTS:
        return str(slide["layout"])
    figs = figures_of(slide)
    if quote_of(slide) is not None and not figs:
        return "quote"
    if len(figs) >= 2:
        return "figures"
    if figs:
        return "figure"
    return "text" if body_sentences(slide) else "title"


def slots_of(slide: dict[str, Any]) -> int:
    """How many card slots the slide's layout shows: its format's `slots` within the layout's range, else a default per
    layout; none for layouts without cards."""
    layout = layout_of(slide)
    if layout not in SLOTS:
        return 0
    lo, hi = SLOTS[layout]
    n = _format(slide).get("slots")
    if not isinstance(n, int) or isinstance(n, bool):
        n = len(figures_of(slide)) if layout == "figures" else lo
    return max(lo, min(hi, n))


def is_grid(slide: dict[str, Any]) -> bool:
    """Whether the slide's cards stand in a grid of two by two rather than in one row."""
    return layout_of(slide) == "figures" and slots_of(slide) == MAX_FIGURES and _format(slide).get("grid") is True


def _format(slide: dict[str, Any]) -> dict[str, Any]:
    return slide["format"] if isinstance(slide.get("format"), dict) else {}


# The layouts by the names the picker, the chat and the writer use (frontend model.ts PRESETS): each is a layout, its
# card slots, a grid, and whether the lines are bullets (None leaves them as they are).
PRESETS: dict[str, tuple[str, int, bool, bool | None]] = {
    "title": ("title", 0, False, None),
    "bullets": ("text", 0, False, True),
    "paragraph": ("text", 0, False, False),
    "bullets + card": ("figure", 1, False, True),
    "paragraph + card": ("figure", 1, False, False),
    "bullets + two cards": ("figure", 2, False, True),
    "paragraph + two cards": ("figure", 2, False, False),
    "card": ("card", 1, False, None),
    "two cards": ("figures", 2, False, None),
    "three cards": ("figures", 3, False, None),
    "four cards": ("figures", 4, False, None),
    "card grid": ("figures", 4, True, None),
    "quote": ("quote", 0, False, None),
}
# other names for them: aliases and plain variants
LAYOUT_ALIASES = {
    "figures": "two cards", "section": "title", "title + text": "text", "text + figure": "figure",
    "two figures": "two cards", "prose": "paragraph", "prose + card": "paragraph + card",
    "prose + two cards": "paragraph + two cards", "card alone": "card", "one card": "card", "full bleed": "card",
    "full-bleed": "card", "full screen": "card", "2 cards": "two cards", "3 cards": "three cards", "4 cards": "four cards",
    "cards side by side": "two cards", "two cards side by side": "two cards", "grid": "card grid",
    "four cards grid": "card grid", "cards in a grid": "card grid", "2x2": "card grid",
}


def layout_spec(raw: Any) -> dict[str, Any] | None:
    """{layout, slots, grid, bullets} for the layout `raw` names: one of PRESETS or an alias (any case, `and` or `&` for
    `+`), or a bare layout id with slots and bullets None. None for none."""
    s = " ".join(str(raw or "").strip().lower().replace("&", "+").replace(" and ", " + ").split())
    s = re.sub(r"\s*\+\s*", " + ", s)
    s = LAYOUT_ALIASES.get(s, s)
    if s in PRESETS:
        layout, slots, grid, bullets = PRESETS[s]
        return {"layout": layout, "slots": slots, "grid": grid, "bullets": bullets}
    if s in LAYOUTS:
        return {"layout": s, "slots": None, "grid": False, "bullets": None}
    return None


def layout_name(raw: Any) -> str | None:
    """The layout id `raw` names (layout_spec); None for none."""
    spec = layout_spec(raw)
    return spec["layout"] if spec else None


def preset_of(slide: dict[str, Any]) -> str:
    """The slide's layout by its name in PRESETS."""
    layout = layout_of(slide)
    if layout == "figures":
        return "card grid" if is_grid(slide) else {2: "two cards", 3: "three cards", 4: "four cards"}[slots_of(slide)]
    if layout in ("text", "figure"):
        lines = body_sentences(slide)
        base = "bullets" if not lines or any(x.get("bullet") for x in lines) else "paragraph"
        return base if layout == "text" else f"{base} + card" if slots_of(slide) == 1 else f"{base} + two cards"
    return layout


def slots_note(slide: dict[str, Any]) -> str:
    """` · N empty slots` or ` · N cards not shown` (past the slots the layout shows), for the slide's layout line in
    read_ref; empty when every slot holds a card and every card has a slot."""
    n, cards = slots_of(slide), len(figures_of(slide))
    if layout_of(slide) == "quote" and quote_of(slide) is None:
        n = min(cards, 1)  # a quote slide without a quote shows its first card in the quote's place
    if cards > n:
        return f" · {cards - n} {'card' if cards - n == 1 else 'cards'} not shown"
    if cards < n:
        return f" · {n - cards} empty {'slot' if n - cards == 1 else 'slots'}"
    return ""


def apply_spec(slide: dict[str, Any], spec: dict[str, Any]) -> None:
    """Set the slide's layout from layout_spec's {layout, slots, grid, bullets}: slots and grid into its format, its
    lines
    made bullets or prose; cards and lines stay. Mutates `slide`."""
    slide["layout"] = spec["layout"]
    fmt = clean_format(slide.get("format"))
    fmt.pop("grid", None)
    if spec["layout"] != "figure":
        fmt.pop("side", None)
        fmt.pop("width", None)
    if spec["layout"] not in SLOTS:
        fmt.pop("slots", None)
    elif spec.get("slots") is not None:
        fmt["slots"] = spec["slots"]
    if spec.get("grid"):
        fmt["grid"] = True
    if fmt:
        slide["format"] = fmt
    else:
        slide.pop("format", None)
    if spec.get("bullets") is not None:
        for x in body_sentences(slide):
            if spec["bullets"]:
                x["bullet"] = x.get("bullet") or report_format.BULLET
            else:
                x.pop("bullet", None)


def grow_slots(slide: dict[str, Any]) -> None:
    """Add card slots while the slide's cards outnumber them and a layout with more room exists. Mutates `slide`."""
    while len(figures_of(slide)) > slots_of(slide):
        layout, slots = layout_of(slide), slots_of(slide)
        if layout in ("text", "title"):
            apply_spec(slide, {"layout": "figure", "slots": 1, "grid": False, "bullets": None})
        elif layout == "figure" and slots < SLOTS["figure"][1]:
            apply_spec(slide, {"layout": "figure", "slots": slots + 1, "grid": False, "bullets": None})
        elif layout == "card":
            apply_spec(slide, {"layout": "figures", "slots": 2, "grid": False, "bullets": None})
        elif layout == "figures" and slots < MAX_FIGURES:
            apply_spec(slide, {"layout": "figures", "slots": slots + 1, "grid": False, "bullets": None})
        else:
            return


def clean_format(raw: Any) -> dict[str, Any]:
    """{side, width, slots, grid} from the analyst's format: the figure's side and its share of the width, the number
    of card slots and whether the cards stand in a grid; {} for none."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    if raw.get("side") in SIDES:
        out["side"] = raw["side"]
    w = raw.get("width")
    if isinstance(w, (int, float)) and not isinstance(w, bool):
        out["width"] = int(min(WIDTH_MAX, max(WIDTH_MIN, round(w))))
    n = raw.get("slots")
    if isinstance(n, int) and not isinstance(n, bool):
        out["slots"] = max(1, min(MAX_FIGURES, n))
    if raw.get("grid") is True:
        out["grid"] = True
    return out


def upgrade(doc: dict[str, Any]) -> dict[str, Any]:
    """A stored deck read back with each slide's figures under `figures` and its notes a string."""
    for s in doc.get("slides") or []:
        if not isinstance(s, dict):
            continue
        s["figures"] = figures_of(s)
        s.pop("figure", None)
        if not isinstance(s.get("notes"), str):
            s["notes"] = ""
        s.setdefault("sentences", [])
    return doc


def frame_from_sections(frame: dict[str, Any]) -> dict[str, Any]:
    """A deck frame stored as sections, read as slides: each section's heading, sentences and figures."""
    if isinstance(frame.get("slides"), list) or not isinstance(frame.get("sections"), list):
        return frame
    slides = []
    for sec in frame["sections"]:
        if not isinstance(sec, dict):
            continue
        sentences = [x for p in sec.get("paragraphs") or [] if isinstance(p, dict) for x in p.get("sentences") or [] if isinstance(x, dict)]
        slide = {k: v for k, v in sec.items() if k not in ("paragraphs", "figures", "role")}
        slide.update(sentences=sentences, figures=[f for f in sec.get("figures") or [] if isinstance(f, dict)][:MAX_FIGURES], notes="")
        slides.append(slide)
    out = {k: v for k, v in frame.items() if k != "sections"}
    out["slides"] = slides
    return out


# a quote in quotation marks with its citations after the closing mark: `"I cleaned up." [[wiki/log.jsonl#L4]]`
_QUOTED_RE = re.compile(r'^["“](.*)["”]((?:\s*\[\[[^\[\]]*\]\])*)$')


def quote_record(raw: Any, valid: _Refs, used: set[str]) -> dict[str, Any] | None:
    """A quote record from {text, speaker}: one sentence marked `quote`, its refs the citations it holds. The cell sets
    the quotation marks, so the ones the text is wrapped in are dropped, also when its citations follow them."""
    if isinstance(raw, str):
        raw = {"text": raw}
    if not isinstance(raw, dict):
        return None
    text = _collapse(raw.get("text"))
    m = _QUOTED_RE.match(text)
    text = f"{m.group(1).strip()}{m.group(2)}" if m else text.strip('"“”')
    if not text:
        return None
    rec = {"id": _new_id(used), "text": text, "refs": valid.clean(refs.extract_refs(text), text), "tags": [], "tag_notes": {},
           "quote": True}
    speaker = _collapse(raw.get("speaker"))
    if speaker:
        rec["speaker"] = speaker
    return rec


def figure_record(raw: Any, valid: _Refs, used: set[str]) -> dict[str, Any] | None:
    """A slide's figure from {cell, caption}: any card the canvas has; None for another."""
    f = raw if isinstance(raw, dict) else {"cell": raw}
    cid = card_id(valid, f.get("cell"))
    if cid is None:
        return None
    return {"id": _new_id(used), "cell": f"card:{cid}", "caption": _collapse(f.get("caption")) or valid.artifacts.get(cid, "")}


def normalize(raw: dict[str, Any], valid: _Refs) -> dict[str, Any]:
    """The stored deck from {title, slides: [{heading, body, figures (or figure), quote, notes, layout}]}: bodies as
    sentence
    records, at most MAX_FIGURES figures on cards the canvas has, the named layout with room for each figure, ids
    minted
    here. 502 when no slide survives."""
    used: set[str] = set()

    def sentence(x: Any) -> dict[str, Any] | None:
        if isinstance(x, str):
            x = {"text": x}
        if not isinstance(x, dict):
            return None
        text = _collapse(x.get("text"))
        if not text:
            return None
        listed = {str(t).strip().lower() for t in x["tags"] if isinstance(t, str)} if isinstance(x.get("tags"), list) else set()
        tags = [t for t in TAGS if t in listed]
        return {"id": _new_id(used), "text": text, "refs": valid.clean(x.get("refs"), text), "tags": tags, "tag_notes": {}}

    slides: list[dict[str, Any]] = []
    for s in raw.get("slides") if isinstance(raw.get("slides"), list) else []:
        if not isinstance(s, dict):
            continue
        heading = _collapse(s.get("heading"))
        sentences = report_format.sentence_units(s.get("body"), valid, used) if isinstance(s.get("body"), (str, list)) else []
        sentences += [y for y in (sentence(x) for x in (s.get("sentences") or [])) if y]
        quote = quote_record(s.get("quote"), valid, used)
        if quote is not None:
            sentences.insert(0, quote)
        wanted = [s.get("figure")] if s.get("figure") else []
        wanted += s.get("figures") if isinstance(s.get("figures"), list) else []
        figures: list[dict[str, Any]] = []
        for f in wanted:
            rec = figure_record(f, valid, used)
            if rec and len(figures) < MAX_FIGURES and all(g["cell"] != rec["cell"] for g in figures):
                figures.append(rec)
        spec = layout_spec(s.get("layout"))
        if not heading or (not sentences and not figures and (spec or {}).get("layout") != "title" and slides):
            continue
        slide: dict[str, Any] = {"id": _new_id(used), "heading": heading, "sentences": sentences, "figures": figures,
                                 "notes": _collapse(s.get("notes")) if isinstance(s.get("notes"), str) else ""}
        if spec:
            apply_spec(slide, spec)
            grow_slots(slide)
        slides.append(slide)
    if not slides:
        raise HTTPException(502, "the deck has no slide with a heading")
    return {"id": DOC_ID, "title": _collapse(raw.get("title")) or "Slides", "slides": slides}


def _heading_match(a: Any, b: Any) -> float:
    want, have = report_format.tokens(a), report_format.tokens(b)
    return len(want & have) / len(want) if want and have else 0.0


def carry_layouts(doc: dict[str, Any], *olds: dict[str, Any] | None) -> None:
    """Store a layout on every slide of a new generation: one the markdown named none for takes the layout and format of
    the
    earlier slide with the same heading or figure, else the one its cards call for. Mutates `doc`."""
    earlier = [s for d in olds if d for s in d.get("slides") or [] if isinstance(s, dict)]
    taken: set[int] = set()
    for s in doc.get("slides") or []:
        if not isinstance(s, dict):
            continue
        if s.get("layout") not in LAYOUTS:
            cells = {str(f.get("cell")) for f in figures_of(s)}
            best, score = None, 0.0
            for i, o in enumerate(earlier):
                if i in taken:
                    continue
                m = 1.0 if _collapse(o.get("heading")) == _collapse(s.get("heading")) else _heading_match(o.get("heading"), s.get("heading"))
                if m < 0.5 and cells & {str(f.get("cell")) for f in figures_of(o)}:
                    m = 0.5
                if m > score:
                    best, score = i, m
            if best is not None and score >= 0.5 and earlier[best].get("layout") in LAYOUTS:
                taken.add(best)
                o = earlier[best]
                s["layout"] = o["layout"]
                if clean_format(o.get("format")):
                    s["format"] = clean_format(o.get("format"))
        s["layout"] = layout_of(s)


def slide_markdown(slide: dict[str, Any]) -> str:
    """One slide in the deck's markdown, as the writer writes it (report_types.parse_markdown reads it back)."""
    lines = [f"## {slide.get('heading') or ''}", ""]
    if slide.get("layout") in LAYOUTS:
        lines += [f"Layout: {preset_of(slide)}", ""]
    q = quote_of(slide)
    if q is not None:
        lines += [f"> {q.get('text') or ''}"] + ([f"> — {q['speaker']}"] if q.get("speaker") else []) + [""]
    for f in figures_of(slide):
        if f.get("cell"):
            lines += [f"![{_collapse(f.get('caption'))}]({f['cell']})", ""]
    body = report_format.body_of(body_sentences(slide))
    if body:
        lines += [body, ""]
    if _collapse(slide.get("notes")):
        lines += [f"Notes. {_collapse(slide.get('notes'))}", ""]
    return "\n".join(lines).rstrip() + "\n"


_SPEAKER_RE = re.compile(r"^\s*(?:—|–|--)\s*(.+?)\s*$")


def split_quote(lines: list[str]) -> tuple[dict[str, Any] | None, list[str]]:
    """(the quote, the other paragraphs) of a slide's paragraphs: a paragraph whose every line starts with `>` is the
    quote, and a last line of it that starts with a dash names its speaker."""
    quote = None
    rest: list[str] = []
    for para in lines:
        rows = [r for r in para.split("\n") if r.strip()]
        if quote is None and rows and all(r.lstrip().startswith(">") for r in rows):
            texts = [r.lstrip()[1:].strip() for r in rows]
            speaker = ""
            if len(texts) > 1 and (m := _SPEAKER_RE.match(texts[-1])):
                speaker = m.group(1)
                texts = texts[:-1]
            quote = {"text": " ".join(t for t in texts if t), "speaker": speaker}
            continue
        rest.append(para)
    return quote, rest
