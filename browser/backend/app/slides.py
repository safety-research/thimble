"""A written document as slides: a .pptx that PowerPoint, Keynote and Google Slides open.

The first slide is the document's title, with the opening section's lead under it when that section has no heading of
its own. Then each section is a slide: its heading, its key sentences (the first sentence of each paragraph and of each
list item), and its first figure, the art the export draws (exports.figure_pictures) with its card's question over it
and its caption under it, beside the 2 pt ink rule. A section's further figures each get a slide of their own under
the same heading, and key sentences that do not fit go on to the next slide. Each slide's notes hold the section's
whole text, so nothing the report says is lost. The look is thimble's: Hanken Grotesk on white, the page the figures'
art is drawn on (exports.PAPER), black text and gray captions.

No library writes the file: the package is the few parts a deck needs (Office Open XML, ECMA-376), written with
zipfile, the text in placeholders where a deck's text goes, so the outline and an editor see it. Each text box is as
tall as its text, measured with the faces' own widths (Pillow, with app/fonts), with room for a viewer that sets the
text in another face.
"""
from __future__ import annotations

import base64
import io
import re
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape, quoteattr

EMU_IN = 914400
EMU_PT = 12700
EMU_PX = 9525  # a CSS px, 1/96 in
SLIDE_W, SLIDE_H = 12192000, 6858000  # 16:9, 13.33 x 7.5 in
NOTES_W, NOTES_H = 6858000, 9144000
MARGIN_X = int(0.6 * EMU_IN)
TOP = int(0.5 * EMU_IN)
BOTTOM = int(0.45 * EMU_IN)
GAP = int(0.3 * EMU_IN)  # between the title and the content, and between the text and the figure
TEXT_W = int(4.4 * EMU_IN)  # the key sentences' column beside a figure; the figure takes the rest
# px: the width a chart is laid out at for a slide, narrower than in the report, so its labels read at about 12 pt there;
# a table or a page keeps the report's width (exports.FIGURE_W), so its cells break where they do in the report
CHART_W = 480
RULE_W = int(2 * EMU_PT)  # the ink rule beside a caption
RULE_GAP = int(8 * EMU_PT)
TITLE_SIZES = (28, 26, 24)  # pt: a section's heading, the largest that fits in three lines
COVER_SIZES = (40, 36, 32, 28)  # pt: the document's title on the first slide
BODY_SIZES = (20, 18, 16, 14)  # pt: the key sentences, the largest that fits
QUESTION_PT = 14
CAPTION_PT = 12
LEAD_PT = 20  # the opening section's lead on the first slide
PARA_AFTER_PT = 10  # space after each key sentence
LINE = 1.303  # Hanken Grotesk's line, its ascent and descent over its em (app/fonts), the height of single spacing
ROOM = 0.9  # the share of a box its measured text may fill: a viewer without Hanken Grotesk sets a wider face
FONTS = Path(__file__).resolve().with_name("fonts")
FACE = "Hanken Grotesk"
MONO = "Geist Mono"
INK, INK_700, INK_500 = "000000", "47474C", "636368"  # Neutral's inks (frontend styles/tokens.css), as the figures'
PAPER_1 = "F5F5F6"  # Neutral's pane
ACCENTS = ("5135FF", "0471C8", "E26101", "018D82", "C8367B", "A08319")  # iris, then the chart series
_INLINE_RE = re.compile(r"\*\*(.+?)\*\*|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|`([^`]+)`|\[([^\]]+)\]\((https?://[^)\s]+)\)")
_BAD_XML_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")  # what XML 1.0 cannot hold

NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument.presentationml"


# --------------------------------------------------------------------------- text: runs and their measure


def _clean(text: str) -> str:
    return _BAD_XML_RE.sub("", text or "")


def runs(text: str) -> list[dict[str, Any]]:
    """A sentence's inline Markdown as runs, each {text, b?, i?, mono?, link?}: bold, emphasis, code and http(s) links,
    as the HTML export reads them (exports.inline_html)."""
    out: list[dict[str, Any]] = []
    pos = 0
    for m in _INLINE_RE.finditer(text or ""):
        if m.start() > pos:
            out.append({"text": text[pos:m.start()]})
        if m.group(1) is not None:
            out.append({"text": m.group(1), "b": True})
        elif m.group(2) is not None:
            out.append({"text": m.group(2), "i": True})
        elif m.group(3) is not None:
            out.append({"text": m.group(3), "mono": True})
        else:
            out.append({"text": m.group(4), "link": m.group(5)})
        pos = m.end()
    if pos < len(text or ""):
        out.append({"text": text[pos:]})
    return [r for r in out if r["text"]]


@lru_cache(maxsize=None)
def _face(name: str) -> Any:
    from PIL import ImageFont  # noqa: PLC0415 — Pillow comes with matplotlib

    return ImageFont.truetype(str(FONTS / name), 1000)


def _width(text: str, *, bold: bool = False, mono: bool = False) -> float:
    """The advance width of `text` in em: Geist Mono for code, Hanken Grotesk Medium for bold (as wide as its Bold within
    1 percent), else Regular."""
    name = "GeistMono-Regular.ttf" if mono else "HankenGrotesk-Medium.ttf" if bold else "HankenGrotesk-Regular.ttf"
    return _face(name).getlength(text) / 1000


def lines(rs: list[dict[str, Any]], width: int, size: float, *, bold: bool = False) -> int:
    """How many lines the runs take in a box `width` EMU wide at `size` pt, broken at spaces as a slide breaks them."""
    room = width / EMU_PT / size  # the box's width in em
    count, used = 1, 0.0
    space = _width(" ")
    for r in rs:
        for word in re.split(r"(\s+)", r["text"]):
            if not word:
                continue
            if word.isspace():
                used += space
                continue
            w = _width(word, bold=bold or bool(r.get("b")), mono=bool(r.get("mono")))
            if used > 0 and used + w > room:
                count += 1 + int(w // room)
                used = w % room
            else:
                used += w
    return count


def text_height(paras: list[list[dict[str, Any]]], width: int, size: float, *, bold: bool = False,
                after: float = 0) -> int:
    """The EMU height of paragraphs of runs set at `size` pt in a box `width` EMU wide, `after` pt between them."""
    n = sum(lines(p, width, size, bold=bold) for p in paras)
    return int((n * size * LINE + after * max(0, len(paras) - 1)) * EMU_PT)


def fit(paras: list[list[dict[str, Any]]], width: int, height: int, sizes: tuple[int, ...], *, bold: bool = False,
        after: float = 0) -> int | None:
    """The largest of `sizes` at which the paragraphs fill at most ROOM of the box; None when none does."""
    for size in sizes:
        if text_height(paras, width, size, bold=bold, after=after) <= height * ROOM:
            return size
    return None


# --------------------------------------------------------------------------- what each slide shows


def key_sentences(u: dict[str, Any]) -> list[dict[str, Any]]:
    """A section's key sentences (exports.read_model's sentences): the first sentence of each paragraph of prose, and of
    each item of a list, as the report splits sentences (report_format.segment_units)."""
    from .report_format import segment_units  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    for p in u["paragraphs"]:
        ss = p["sentences"]
        if ss and all(s["bullet"] for s in ss):
            out += [{**s, "text": next((x["text"] for para in segment_units(s["text"]) for x in para), s["text"])} for s in ss]
        elif ss:
            out.append(ss[0])
    return out


def note_text(u: dict[str, Any]) -> list[str]:
    """A section's whole text for its slide's notes: its heading, then each paragraph, a list item a line of its own."""
    out = [u["heading"]] if u["heading"] else []
    for p in u["paragraphs"]:
        ss = p["sentences"]
        if ss and all(s["bullet"] for s in ss):
            out += [f"{'1.' if s['bullet'] == '1.' else '•'} {s['text']}" for s in ss]
        elif ss:
            out.append(" ".join(s["text"] for s in ss))
    return [_plain(t) for t in out if t]


def _plain(text: str) -> str:
    return "".join(r["text"] for r in runs(text))


def plan(m: dict[str, Any]) -> list[dict[str, Any]]:
    """The slides of a document read by exports.read_model, each {kind: cover or section, title, sentences, figure,
    notes}: the cover with the opening section's lead when it has no heading, then a slide per section and one more for
    each further figure of a section."""
    us = list(m["units"])
    cover: dict[str, Any] = {"kind": "cover", "title": m["title"], "sentences": [], "figure": None, "notes": []}
    if us and not us[0]["heading"] and not us[0]["figures"]:
        lead = us.pop(0)
        cover["sentences"], cover["notes"] = key_sentences(lead), note_text(lead)
    out = [cover]
    for u in us:
        figs = [f for kind, f in _blocks(u) if kind == "figure"]
        out.append({"kind": "section", "title": u["heading"], "sentences": key_sentences(u),
                    "figure": figs[0] if figs else None, "notes": note_text(u)})
        out += [{"kind": "section", "title": u["heading"], "sentences": [], "figure": f, "notes": []} for f in figs[1:]]
    return out


def _blocks(u: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    from .exports import unit_blocks  # noqa: PLC0415 — exports imports this module lazily

    return unit_blocks(u)


# --------------------------------------------------------------------------- shapes


def _rpr(r: dict[str, Any], size: float, color: str, links: dict[str, str], *, bold: bool = False) -> str:
    attrs = f' lang="en-US" sz="{int(round(size * 100))}"'
    if bold or r.get("b"):
        attrs += ' b="1"'
    if r.get("i"):
        attrs += ' i="1"'
    inner = f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
    if r.get("mono"):
        inner += f'<a:latin typeface="{MONO}"/><a:cs typeface="{MONO}"/>'
    if r.get("link"):
        rid = links.setdefault(r["link"], f"rIdL{len(links) + 1}")
        inner += f'<a:hlinkClick r:id="{rid}"/>'
    return f"<a:rPr{attrs} dirty=\"0\">{inner}</a:rPr>"


def _para(rs: list[dict[str, Any]], size: float, color: str, links: dict[str, str], *, bold: bool = False,
          bullet: str | None = None, after: float = 0) -> str:
    ppr = ""
    if bullet is not None or after:
        spc = f'<a:spcAft><a:spcPts val="{int(after * 100)}"/></a:spcAft>' if after else ""
        if bullet == "1.":
            bu = (f'<a:buClr><a:srgbClr val="{INK_500}"/></a:buClr><a:buFont typeface="+mj-lt"/>'
                  '<a:buAutoNum type="arabicPeriod"/>')
        elif bullet:
            bu = f'<a:buClr><a:srgbClr val="{INK_500}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>'
        else:
            bu = "<a:buNone/>"
        indent = f' marL="{int(size * 1.2 * EMU_PT)}" indent="-{int(size * 1.2 * EMU_PT)}"' if bullet else ' marL="0" indent="0"'
        ppr = f"<a:pPr{indent}>{spc}{bu}</a:pPr>"
    body = "".join(f"<a:r>{_rpr(r, size, color, links, bold=bold)}<a:t>{escape(_clean(r['text']))}</a:t></a:r>" for r in rs)
    end = f'<a:endParaRPr lang="en-US" sz="{int(round(size * 100))}" dirty="0"/>'
    return f"<a:p>{ppr}{body}{end}</a:p>"


def _xfrm(x: int, y: int, w: int, h: int) -> str:
    return f'<a:xfrm><a:off x="{int(x)}" y="{int(y)}"/><a:ext cx="{max(1, int(w))}" cy="{max(1, int(h))}"/></a:xfrm>'


BODY_PR = ('<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="{anchor}" rtlCol="0">'
           '<a:noAutofit/></a:bodyPr>')


def _placeholder(sid: int, name: str, ph: str, box: tuple[int, int, int, int], paras_xml: str, *,
                 anchor: str = "t") -> str:
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name={quoteattr(name)}/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
            f"<p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:spPr>{_xfrm(*box)}</p:spPr>"
            f'<p:txBody>{BODY_PR.format(anchor=anchor)}<a:lstStyle/>{paras_xml}</p:txBody></p:sp>')


def _textbox(sid: int, name: str, box: tuple[int, int, int, int], paras_xml: str) -> str:
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name={quoteattr(name)}/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr>{_xfrm(*box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
            f'<p:txBody>{BODY_PR.format(anchor="t")}<a:lstStyle/>{paras_xml}</p:txBody></p:sp>')


def _rule(sid: int, box: tuple[int, int, int, int]) -> str:
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="Rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr>{_xfrm(*box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
            f'<a:solidFill><a:srgbClr val="{INK}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>')


def _picture(sid: int, name: str, descr: str, rid: str, box: tuple[int, int, int, int]) -> str:
    return (f'<p:pic><p:nvPicPr><p:cNvPr id="{sid}" name={quoteattr(name)} descr={quoteattr(_clean(descr))}/>'
            f'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
            f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
            f'<p:spPr>{_xfrm(*box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>')


def _tree(shapes: list[str]) -> str:
    return ('<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>'
            f'</a:xfrm></p:grpSpPr>{"".join(shapes)}</p:spTree>')


# --------------------------------------------------------------------------- a slide laid out


class Slide:
    """One slide's shapes as it is laid out, its picture and links for its relationships, and its notes."""

    def __init__(self, layout: int, notes: list[str]):
        self.layout = layout
        self.shapes: list[str] = []
        self.links: dict[str, str] = {}
        self.image: str | None = None  # the media part's name of its picture
        self.notes = notes
        self._id = 1

    def sid(self) -> int:
        self._id += 1
        return self._id


def _figure(s: Slide, f: dict[str, Any], pic: dict[str, Any], x: int, y: int, w: int, h: int,
            media: dict[str, str], images: dict[str, bytes]) -> None:
    """A figure in the box at (x, y), `w` by `h` EMU, as the report's page shows it: its card's question, its picture
    as large as the rest of the box allows at the picture's own shape, and its caption beside the ink rule."""
    question = runs(pic.get("question") or "")
    caption = runs(f.get("caption") or "")
    q_h = int(text_height([question], w, QUESTION_PT, bold=True) / ROOM) if question else 0
    cap_w = w - RULE_W - RULE_GAP
    cap_h = text_height([caption], cap_w, CAPTION_PT) if caption else 0
    room = h - q_h - int(cap_h / ROOM) - (GAP // 2 if question else 0) - (GAP // 2 if caption else 0)
    pw, ph = float(pic.get("width") or 0) * EMU_PX, float(pic.get("height") or 0) * EMU_PX
    top = y
    if question:
        s.shapes.append(_textbox(s.sid(), "Question", (x, top, w, q_h), _para(question, QUESTION_PT, INK, s.links, bold=True)))
        top += q_h + GAP // 2
    if pic.get("png") and pw > 0 and ph > 0 and room > 0:
        scale = min(w / pw, room / ph)
        pw, ph = pw * scale, ph * scale
        if pic["png"] not in media:
            media[pic["png"]] = f"image{len(media) + 1}.png"
            images[media[pic["png"]]] = base64.b64decode(pic["png"])
        s.image = media[pic["png"]]
        s.shapes.append(_picture(s.sid(), "Figure", pic.get("question") or "Figure", "rIdImg", (x, top, pw, ph)))
        top += int(ph)
    if caption:
        top += GAP // 2
        s.shapes.append(_rule(s.sid(), (x, top, RULE_W, cap_h)))
        s.shapes.append(_textbox(s.sid(), "Caption", (x + RULE_W + RULE_GAP, top, cap_w, cap_h / ROOM),
                                 _para(caption, CAPTION_PT, INK_700, s.links)))


def _title(s: Slide, text: str, sizes: tuple[int, ...], box_w: int, *, ph: str) -> int:
    """The slide's title in its placeholder at the top, at the largest of `sizes` that fits in three lines; its height."""
    rs = runs(text)
    size = next((z for z in sizes if lines(rs, box_w, z, bold=True) <= 3), sizes[-1])
    h = text_height([rs], box_w, size, bold=True)
    s.shapes.append(_placeholder(s.sid(), "Title", ph, (MARGIN_X, TOP, box_w, h / ROOM),
                                 _para(rs, size, INK, s.links, bold=True)))
    return int(h / ROOM)


def _sentences_xml(s: Slide, ss: list[dict[str, Any]], size: int, *, bullets: bool) -> str:
    return "".join(_para(runs(x["text"]), size, INK, s.links, bullet=(x["bullet"] or "-") if bullets else None,
                         after=PARA_AFTER_PT) for x in ss)


def layout(spec: dict[str, Any], pics: dict[str, dict[str, Any]], media: dict[str, str],
           images: dict[str, bytes]) -> list[Slide]:
    """The slide or slides one entry of plan() lays out: more than one when its key sentences do not fit on one."""
    full_w = SLIDE_W - 2 * MARGIN_X
    if spec["kind"] == "cover":
        s = Slide(1, spec["notes"])
        paras = [runs(x["text"]) for x in spec["sentences"]]
        lead_h = text_height(paras, full_w, LEAD_PT, after=PARA_AFTER_PT) if paras else 0
        rs = runs(spec["title"])
        size = next((z for z in COVER_SIZES if lines(rs, full_w, z, bold=True) <= 3), COVER_SIZES[-1])
        title_h = int(text_height([rs], full_w, size, bold=True) / ROOM)
        block = title_h + (GAP + lead_h if paras else 0)
        top = max(TOP, (SLIDE_H - block) // 2 - int(0.3 * EMU_IN))
        s.shapes.append(_placeholder(s.sid(), "Title", '<p:ph type="ctrTitle"/>', (MARGIN_X, top, full_w, title_h),
                                     _para(rs, size, INK, s.links, bold=True), anchor="b"))
        if paras:
            xml = "".join(_para(p, LEAD_PT, INK_700, s.links, after=PARA_AFTER_PT) for p in paras)
            s.shapes.append(_placeholder(s.sid(), "Subtitle", '<p:ph type="subTitle" idx="1"/>',
                                         (MARGIN_X, top + title_h + GAP, full_w, lead_h / ROOM), xml))
        return [s]
    f = spec["figure"]
    ss = list(spec["sentences"])
    out: list[Slide] = []
    while True:
        s = Slide(2, spec["notes"] if not out else [])
        title_h = _title(s, spec["title"], TITLE_SIZES, full_w, ph='<p:ph type="title"/>') if spec["title"] else 0
        y = TOP + title_h + (GAP if title_h else 0)
        h = SLIDE_H - BOTTOM - y
        beside = f is not None and not out  # the figure stands beside the text on the section's first slide
        text_w = TEXT_W if beside else full_w
        if ss:
            paras = [runs(x["text"]) for x in ss]
            size = fit(paras, text_w, h, BODY_SIZES, after=PARA_AFTER_PT)
            keep = len(ss)
            while size is None and keep > 1:  # the rest go on to the next slide, under the same heading
                keep -= 1
                size = fit(paras[:keep], text_w, h, BODY_SIZES, after=PARA_AFTER_PT)
            size = size or BODY_SIZES[-1]
            here, ss = ss[:keep], ss[keep:]
            bullets = len(here) > 1 or any(x["bullet"] for x in here)
            th = text_height([runs(x["text"]) for x in here], text_w, size, after=PARA_AFTER_PT)
            s.shapes.append(_placeholder(s.sid(), "Text", '<p:ph idx="1"/>', (MARGIN_X, y, text_w, min(h, th / ROOM)),
                                         _sentences_xml(s, here, size, bullets=bullets)))
        if beside:
            # a figure the harness could not draw keeps its question and caption, so the slide still says what it showed
            fx = MARGIN_X + (TEXT_W + GAP if spec["sentences"] else 0)
            _figure(s, f, pics.get(f["card"]) or {}, fx, y, SLIDE_W - MARGIN_X - fx, h, media, images)
        out.append(s)
        if not ss:
            return out


# --------------------------------------------------------------------------- the package


def _slide_xml(s: Slide) -> str:
    return (f"{XML}<p:sld {NS}><p:cSld>{_tree(s.shapes)}</p:cSld>"
            "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>")


def _rels(items: list[tuple[str, str, str]]) -> str:
    body = "".join(f'<Relationship Id="{rid}" Type="{typ}" Target={quoteattr(target)}'
                   + (' TargetMode="External"' if typ.endswith("/hyperlink") else "") + "/>"
                   for rid, typ, target in items)
    return f'{XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>'


def _notes_xml(paras: list[str]) -> str:
    text = "".join(f'<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{escape(_clean(t))}</a:t></a:r></a:p>' for t in paras)
    shapes = [
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/>'
        '</p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>',
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        f'<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{text}'
        '</p:txBody></p:sp>',
    ]
    return f"{XML}<p:notes {NS}><p:cSld>{_tree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"


def _theme(paper: str) -> str:
    """thimble's theme: its inks, the report's paper, iris and the chart series as accents, Hanken Grotesk for titles
    and text, and flat fills and lines."""
    colors = {"dk1": INK, "lt1": paper, "dk2": INK_700, "lt2": PAPER_1,
              **{f"accent{i + 1}": c for i, c in enumerate(ACCENTS)}, "hlink": "5135FF", "folHlink": "4228AA"}
    scheme = "".join(f'<a:{k}><a:srgbClr val="{v}"/></a:{k}>' for k, v in colors.items())
    font = f'<a:latin typeface="{FACE}"/><a:ea typeface=""/><a:cs typeface=""/>'
    fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    line = '<a:ln w="{w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>'
    return (f'{XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="thimble"><a:themeElements>'
            f'<a:clrScheme name="thimble">{scheme}</a:clrScheme>'
            f'<a:fontScheme name="thimble"><a:majorFont>{font}</a:majorFont><a:minorFont>{font}</a:minorFont></a:fontScheme>'
            f'<a:fmtScheme name="thimble"><a:fillStyleLst>{fill * 3}</a:fillStyleLst>'
            f'<a:lnStyleLst>{"".join(line.format(w=w) for w in (9525, 19050, 28575))}</a:lnStyleLst>'
            f'<a:effectStyleLst>{"<a:effectStyle><a:effectLst/></a:effectStyle>" * 3}</a:effectStyleLst>'
            f'<a:bgFillStyleLst>{fill * 3}</a:bgFillStyleLst></a:fmtScheme>'
            '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>')


def _level_style(size: int, *, title: bool = False) -> str:
    font, bold = ("+mj", ' b="1"') if title else ("+mn", "")
    return (f'<a:lvl1pPr marL="0" indent="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">'
            f'<a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/>'
            f'<a:defRPr sz="{size * 100}"{bold} kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>'
            f'<a:latin typeface="{font}-lt"/><a:ea typeface="{font}-ea"/><a:cs typeface="{font}-cs"/></a:defRPr></a:lvl1pPr>')


CLR_MAP = ('<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
           'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>')


def _master(paper: str) -> str:
    full_w = SLIDE_W - 2 * MARGIN_X
    shapes = [
        _placeholder(2, "Title", '<p:ph type="title"/>', (MARGIN_X, TOP, full_w, int(1.2 * EMU_IN)), '<a:p><a:endParaRPr lang="en-US"/></a:p>'),
        _placeholder(3, "Text", '<p:ph type="body" idx="1"/>', (MARGIN_X, int(2 * EMU_IN), full_w, int(4.5 * EMU_IN)),
                     '<a:p><a:endParaRPr lang="en-US"/></a:p>'),
    ]
    bg = f'<p:bg><p:bgPr><a:solidFill><a:srgbClr val="{paper}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
    return (f"{XML}<p:sldMaster {NS}><p:cSld>{bg}{_tree(shapes)}</p:cSld>{CLR_MAP}"
            '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/>'
            f"</p:sldLayoutIdLst><p:txStyles><p:titleStyle>{_level_style(28, title=True)}</p:titleStyle>"
            f"<p:bodyStyle>{_level_style(18)}</p:bodyStyle><p:otherStyle>{_level_style(18)}</p:otherStyle></p:txStyles>"
            "</p:sldMaster>")


def _layout(kind: str, name: str, phs: list[tuple[str, str, tuple[int, int, int, int]]]) -> str:
    shapes = [_placeholder(i + 2, label, ph, box, '<a:p><a:endParaRPr lang="en-US"/></a:p>') for i, (label, ph, box) in enumerate(phs)]
    return (f'{XML}<p:sldLayout {NS} type="{kind}" preserve="1"><p:cSld name={quoteattr(name)}>{_tree(shapes)}</p:cSld>'
            "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>")


def _notes_master() -> str:
    """The notes pages' master: the slide's picture over its notes, as PowerPoint lays a notes page out."""
    shapes = [
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/>'
        f'</p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>{_xfrm(685800, 685800, 5486400, 3086100)}'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/>'
        '</a:solidFill></a:ln></p:spPr></p:sp>',
        _placeholder(3, "Notes", '<p:ph type="body" sz="quarter" idx="3"/>', (685800, 4114800, 5486400, 4114800),
                     '<a:p><a:endParaRPr lang="en-US"/></a:p>'),
    ]
    style = ('<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">'
             '<a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/>'
             '<a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>')
    return (f'{XML}<p:notesMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
            f"{_tree(shapes)}</p:cSld>{CLR_MAP}<p:notesStyle>{style}</p:notesStyle></p:notesMaster>")


def deck(m: dict[str, Any], pics: dict[str, dict[str, Any]]) -> bytes:
    """The document read by exports.read_model as a .pptx, its figures' art from `pics` (exports.figure_pictures)."""
    from .exports import PAPER  # noqa: PLC0415 — exports imports this module lazily

    paper = PAPER.lstrip("#").upper()
    media: dict[str, str] = {}
    images: dict[str, bytes] = {}
    slides = [s for spec in plan(m) for s in layout(spec, pics, media, images)]
    parts: dict[str, str | bytes] = {}
    full_w = SLIDE_W - 2 * MARGIN_X
    noted = [n for n, s in enumerate(slides, 1) if s.notes]
    for n, s in enumerate(slides, 1):
        parts[f"ppt/slides/slide{n}.xml"] = _slide_xml(s)
        rels = [("rId1", f"{REL}/slideLayout", f"../slideLayouts/slideLayout{s.layout}.xml")]
        if s.notes:
            rels.append(("rId2", f"{REL}/notesSlide", f"../notesSlides/notesSlide{n}.xml"))
            parts[f"ppt/notesSlides/notesSlide{n}.xml"] = _notes_xml(s.notes)
            parts[f"ppt/notesSlides/_rels/notesSlide{n}.xml.rels"] = _rels([
                ("rId1", f"{REL}/notesMaster", "../notesMasters/notesMaster1.xml"),
                ("rId2", f"{REL}/slide", f"../slides/slide{n}.xml")])
        if s.image:
            rels.append(("rIdImg", f"{REL}/image", f"../media/{s.image}"))
        rels += [(rid, f"{REL}/hyperlink", url) for url, rid in s.links.items()]
        parts[f"ppt/slides/_rels/slide{n}.xml.rels"] = _rels(rels)
    for name, data in images.items():
        parts[f"ppt/media/{name}"] = data
    parts["ppt/slideMasters/slideMaster1.xml"] = _master(paper)
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = _rels([
        ("rId1", f"{REL}/slideLayout", "../slideLayouts/slideLayout1.xml"),
        ("rId2", f"{REL}/slideLayout", "../slideLayouts/slideLayout2.xml"),
        ("rId3", f"{REL}/theme", "../theme/theme1.xml")])
    parts["ppt/slideLayouts/slideLayout1.xml"] = _layout("title", "Title Slide", [
        ("Title", '<p:ph type="ctrTitle"/>', (MARGIN_X, int(2.2 * EMU_IN), full_w, int(1.6 * EMU_IN))),
        ("Subtitle", '<p:ph type="subTitle" idx="1"/>', (MARGIN_X, int(4.1 * EMU_IN), full_w, int(1.4 * EMU_IN)))])
    parts["ppt/slideLayouts/slideLayout2.xml"] = _layout("obj", "Title and Content", [
        ("Title", '<p:ph type="title"/>', (MARGIN_X, TOP, full_w, int(1.2 * EMU_IN))),
        ("Text", '<p:ph idx="1"/>', (MARGIN_X, int(2 * EMU_IN), full_w, int(4.5 * EMU_IN)))])
    for n in (1, 2):
        parts[f"ppt/slideLayouts/_rels/slideLayout{n}.xml.rels"] = _rels([
            ("rId1", f"{REL}/slideMaster", "../slideMasters/slideMaster1.xml")])
    parts["ppt/notesMasters/notesMaster1.xml"] = _notes_master()
    parts["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = _rels([("rId1", f"{REL}/theme", "../theme/theme2.xml")])
    parts["ppt/theme/theme1.xml"] = _theme(paper)
    parts["ppt/theme/theme2.xml"] = _theme("FFFFFF")
    parts["ppt/presProps.xml"] = f"{XML}<p:presentationPr {NS}/>"
    parts["ppt/viewProps.xml"] = (f'{XML}<p:viewPr {NS}><p:normalViewPr><p:restoredLeft sz="15620"/>'
                                  '<p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>')
    parts["ppt/tableStyles.xml"] = (f'{XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                                    'def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>')
    ids = "".join(f'<p:sldId id="{255 + n}" r:id="rId{100 + n}"/>' for n in range(1, len(slides) + 1))
    parts["ppt/presentation.xml"] = (
        f'{XML}<p:presentation {NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
        f'</p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst>'
        f'<p:sldSz cx="{SLIDE_W}" cy="{SLIDE_H}"/><p:notesSz cx="{NOTES_W}" cy="{NOTES_H}"/></p:presentation>')
    parts["ppt/_rels/presentation.xml.rels"] = _rels(
        [("rId1", f"{REL}/slideMaster", "slideMasters/slideMaster1.xml"),
         ("rId2", f"{REL}/notesMaster", "notesMasters/notesMaster1.xml"),
         ("rId3", f"{REL}/theme", "theme/theme1.xml"),
         ("rId4", f"{REL}/presProps", "presProps.xml"),
         ("rId5", f"{REL}/viewProps", "viewProps.xml"),
         ("rId6", f"{REL}/tableStyles", "tableStyles.xml")]
        + [(f"rId{100 + n}", f"{REL}/slide", f"slides/slide{n}.xml") for n in range(1, len(slides) + 1)])
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    parts["docProps/core.xml"] = (
        f'{XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f'<dc:title>{escape(_clean(m["title"]))}</dc:title>'
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified></cp:coreProperties>')
    parts["docProps/app.xml"] = (
        f'{XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        f"<Application>thimble</Application><PresentationFormat>Widescreen</PresentationFormat>"
        f"<Slides>{len(slides)}</Slides><Notes>{len(noted)}</Notes></Properties>")
    overrides = {"/ppt/presentation.xml": f"{CT}.presentation.main+xml",
                 "/ppt/slideMasters/slideMaster1.xml": f"{CT}.slideMaster+xml",
                 "/ppt/notesMasters/notesMaster1.xml": f"{CT}.notesMaster+xml",
                 "/ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
                 "/ppt/theme/theme2.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
                 "/ppt/presProps.xml": f"{CT}.presProps+xml", "/ppt/viewProps.xml": f"{CT}.viewProps+xml",
                 "/ppt/tableStyles.xml": f"{CT}.tableStyles+xml",
                 "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
                 "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml"}
    overrides |= {f"/ppt/slideLayouts/slideLayout{n}.xml": f"{CT}.slideLayout+xml" for n in (1, 2)}
    for n in range(1, len(slides) + 1):
        overrides[f"/ppt/slides/slide{n}.xml"] = f"{CT}.slide+xml"
    for n in noted:
        overrides[f"/ppt/notesSlides/notesSlide{n}.xml"] = f"{CT}.notesSlide+xml"
    types = ('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
             + "".join(f'<Override PartName="{k}" ContentType="{v}"/>' for k, v in overrides.items()))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", f'{XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{types}</Types>')
        z.writestr("_rels/.rels", _rels([
            ("rId1", f"{REL}/officeDocument", "ppt/presentation.xml"),
            ("rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"),
            ("rId3", f"{REL}/extended-properties", "docProps/app.xml")]))
        for name, data in parts.items():
            if isinstance(data, bytes):
                z.writestr(name, data, compress_type=zipfile.ZIP_STORED)
            else:
                z.writestr(name, data)
    return buf.getvalue()
