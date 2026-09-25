"""The writer's markdown made into sentence records, and the records made back into markdown: segmentation, the
stored sentence shape, the report's roles and takeaway links, the figures of a section, the previous generation as
text for a revision."""
from __future__ import annotations

import logging
import re
from typing import Any

from . import material, refs

log = logging.getLogger("thimble.report_format")

LOCKED_MARK = "[locked]"
PINNED_MARK = "[pinned]"
LINK_MIN_OVERLAP = 0.5  # the share of a finding heading's tokens a takeaway sentence must hold to link to it
TLDR_RE = re.compile(r"^\W*tl\W*dr\b", re.IGNORECASE)

# words after which a period does not end a sentence; "no" only before a digit, and a lone capital never ends one
ABBREVIATIONS = frozenset({"e.g", "i.e", "vs", "cf", "etc", "approx", "al", "fig", "dr", "mr", "ms", "mrs", "st", "no"})
_INITIAL_RE = re.compile(r"^[A-Z]$")

_TOKEN_RE = re.compile(r"[a-z0-9]{4,}")
_STOPWORDS = frozenset("""
that this with from have were what when which their there these those they them then than into onto over under also
been being about after before because while where would could should does done each every much many more most some
such only same other just like make made take used using very well will your ours whose whom against between through
during without within along across since until again further here both either neither although whether itself
himself herself themselves ourselves yourself might must shall cannot however therefore whereas already still even
another anything something nothing everything anyone someone everyone none seems seemed became become becomes
""".split())


def tokens(text: Any) -> set[str]:
    """The content words of a text, four letters or more, stopwords out."""
    return {t for t in _TOKEN_RE.findall(str(text or "").lower()) if t not in _STOPWORDS}


# --------------------------------------------------------------------------- segmentation

_MASK_OPEN, _MASK_CLOSE = "\ue000", "\ue001"  # private-use chars: no period, digit, letter or quote inside a placeholder
_CODE_OPEN, _CODE_CLOSE = "", ""
_MASK_RE = re.compile(rf"{_MASK_OPEN}(\d+){_MASK_CLOSE}")
_CODE_MASK_RE = re.compile(rf"{_CODE_OPEN}(\d+){_CODE_CLOSE}")
_CODE_SPAN_RE = re.compile(r"(`+)([^`\n]+?)\1")
_LIST_RE = re.compile(r"^\s{0,3}(?:[-*+•]|\d{1,3}[.)])\s+")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+")
_FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_QUOTE_RE = re.compile(r"^\s{0,3}>\s?")
_MARK_RE = re.compile(r"\s*\[(?:locked|pinned)\]")
# a sentence end: terminal punctuation, closing quotes, brackets or emphasis, whitespace, then what opens a sentence
_SPLIT_RE = re.compile(r"[.!?]+[\"'”’)\]*_]*\s+(?=[A-Z0-9\"“‘'(\[*_" + _MASK_OPEN + _CODE_OPEN + "])")


def _mask(text: str) -> tuple[str, list[str]]:
    """Every [[...]] token replaced by a placeholder carrying its index, so no split lands inside a citation."""
    tokens_: list[str] = []

    def sub(m: re.Match[str]) -> str:
        tokens_.append(m.group(0))
        return f"{_MASK_OPEN}{len(tokens_) - 1}{_MASK_CLOSE}"

    return refs._BRACKETS.sub(sub, text), tokens_


def _mask_code(text: str, tokens_: list[str]) -> str:
    """Every code span replaced by a placeholder of its own kind, so no split lands inside backticks."""

    def sub(m: re.Match[str]) -> str:
        tokens_.append(m.group(0))
        return f"{_CODE_OPEN}{len(tokens_) - 1}{_CODE_CLOSE}"

    return _CODE_SPAN_RE.sub(sub, text)


def _unmask(text: str, tokens_: list[str]) -> str:
    text = _CODE_MASK_RE.sub(lambda m: tokens_[int(m.group(1))], text)
    return _MASK_RE.sub(lambda m: tokens_[int(m.group(1))], text)


def unwrap_code_refs(text: str) -> str:
    """A citation set in backticks, alone or with other refs, becomes the refs themselves."""

    def sub(m: re.Match[str]) -> str:
        inner = m.group(2)
        if refs._BRACKETS.search(inner) and not refs._BRACKETS.sub("", inner).strip(" \t,;"):
            return inner.strip()
        return m.group(0)

    return _CODE_SPAN_RE.sub(sub, text)


def _bare_placeholder(token: str) -> bool:
    return "|" not in token


def _split_sentences(chunk: str, tokens_: list[str]) -> list[str]:
    """One masked chunk into sentence texts, still masked."""
    parts: list[str] = []
    last = 0
    for m in _SPLIT_RE.finditer(chunk):
        before = chunk[:m.start()].split()
        word = before[-1] if before else ""
        word = word.strip("\"'“”‘’()[]*_").rstrip(".")
        low = word.lower()
        after = chunk[m.end():]
        if _INITIAL_RE.match(word):
            continue
        if low in ABBREVIATIONS and (low != "no" or after[:1].isdigit()):
            continue
        end = m.start() + len(m.group(0).rstrip())
        parts.append(chunk[last:end])
        last = m.end()
    parts.append(chunk[last:])
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        lead = re.match(rf"^((?:{_MASK_OPEN}\d+{_MASK_CLOSE}\s*)+)(?=\s|$)", part)
        if lead and out:
            heads = _MASK_RE.findall(lead.group(1))
            if all(_bare_placeholder(tokens_[int(i)]) for i in heads):
                out[-1] = out[-1] + " " + lead.group(1).strip()
                part = part[lead.end():].strip()
                if not part:
                    continue
        out.append(part)
    return out


def _table_sentences(rows: list[str]) -> list[str]:
    out: list[str] = []
    for row in rows:
        if _TABLE_SEP_RE.match(row):
            continue
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        line = " | ".join(c for c in cells if c)
        if line:
            out.append(line)
    return out


BULLET, NUMBER = "-", "1."


def _marker(line: str) -> str:
    m = _LIST_RE.match(line)
    return NUMBER if m and m.group(0).strip()[:1].isdigit() else BULLET


def segment_units(body: str) -> list[list[dict[str, Any]]]:
    """A markdown body as paragraphs of units {text, bullet}: one sentence of prose, or one list item with its marker as
    `bullet`. Headings, fenced blocks and tables stay whole, and nothing splits inside a citation, code span or
    number."""
    text = str(body or "").replace("\r\n", "\n").replace("\r", "\n")
    text = unwrap_code_refs(_MARK_RE.sub("", text))
    masked, tokens_ = _mask(text)
    masked = _mask_code(masked, tokens_)
    lines = masked.split("\n")
    paragraphs: list[list[tuple[str, str | None]]] = []
    i = 0
    n = len(lines)

    def flush_prose(buf: list[str]) -> None:
        chunk = "\n".join(buf).strip()
        if chunk:
            paragraphs.append([(t, None) for t in _split_sentences(chunk, tokens_)])

    prose: list[str] = []
    while i < n:
        line = lines[i]
        fence = _FENCE_RE.match(line)
        if fence:
            flush_prose(prose)
            prose = []
            mark = fence.group(1)
            j = i + 1
            while j < n and not lines[j].strip().startswith(mark):
                j += 1
            code = " ".join(" ".join(lines[i:min(j + 1, n)]).split())
            if code:
                paragraphs.append([(code, None)])
            i = j + 1
            continue
        if not line.strip():
            flush_prose(prose)
            prose = []
            i += 1
            continue
        if _HEADING_RE.match(line):
            flush_prose(prose)
            prose = []
            head = _HEADING_RE.sub("", line).strip().rstrip("#").strip()
            if head:
                paragraphs.append([(t, None) for t in _split_sentences(head, tokens_)])
            i += 1
            continue
        if _TABLE_ROW_RE.match(line):
            flush_prose(prose)
            prose = []
            j = i
            while j < n and _TABLE_ROW_RE.match(lines[j]):
                j += 1
            rows = _table_sentences(lines[i:j])
            if rows:
                paragraphs.append([(r, None) for r in rows])
            i = j
            continue
        if _LIST_RE.match(line):
            flush_prose(prose)
            prose = []
            items: list[tuple[list[str], str]] = []
            j = i
            while j < n and lines[j].strip() and not _FENCE_RE.match(lines[j]) and not _HEADING_RE.match(lines[j]):
                if _LIST_RE.match(lines[j]):
                    items.append(([_LIST_RE.sub("", lines[j])], _marker(lines[j])))
                elif items:
                    items[-1][0].append(lines[j].strip())
                j += 1
            units: list[tuple[str, str | None]] = []
            for item, marker in items:
                whole = " ".join(item).strip()
                if whole:
                    units.append((whole, marker))
            if units:
                paragraphs.append(units)
            i = j
            continue
        prose.append(_QUOTE_RE.sub("", line) if _QUOTE_RE.match(line) else line)
        i += 1
    flush_prose(prose)
    out: list[list[dict[str, Any]]] = []
    for para in paragraphs:
        units = [{"text": material.collapse(_unmask(t, tokens_)), "bullet": b} for t, b in para]
        units = [u for u in units if u["text"]]
        if units:
            out.append(units)
    return out


def segment_body(body: str) -> list[list[str]]:
    """segment_units' texts alone."""
    return [[u["text"] for u in para] for para in segment_units(body)]


def records_of(units: list[dict[str, Any]], valid: Any, used: set[str], **extra: Any) -> list[dict[str, Any]]:
    """The stored sentence records of one paragraph of units, ids minted from `used`, refs the citations that resolve."""
    from . import report  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    for u in units:
        rec = {"id": report._new_id(used), "text": u["text"], "refs": valid.clean(refs.extract_refs(u["text"]), u["text"]),
               "tags": [], "tag_notes": {}}
        if u.get("bullet"):
            rec["bullet"] = u["bullet"]
        rec.update(extra)
        out.append(rec)
    return out


def sentence_units(body: Any, valid: Any, used: set[str], **extra: Any) -> list[dict[str, Any]]:
    """records_of over every paragraph of a markdown body, flat. A list given as the body is joined with blank lines."""
    if isinstance(body, list):
        body = "\n\n".join(str(b) for b in body if isinstance(b, str))
    return [rec for para in segment_units(body if isinstance(body, str) else "") for rec in records_of(para, valid, used, **extra)]


def one_sentence(body: Any, valid: Any, used: set[str]) -> dict[str, Any] | None:
    """One record from a body meant to hold one sentence, the units joined by a space; None when the body is empty."""
    units = sentence_units(body, valid, used)
    if not units:
        return None
    if len(units) == 1:
        units[0].pop("bullet", None)
        return units[0]
    text = " ".join(u["text"] for u in units)
    return {"id": units[0]["id"], "text": text, "refs": valid.clean(refs.extract_refs(text), text), "tags": [], "tag_notes": {}}


def body_of(sentences: list[dict[str, Any]], locked: set[str] | None = None) -> str:
    """A markdown body from sentence records, the inverse of sentence_units. Prose joins by a space, a run of bullets
    renders as list lines, and a locked sentence carries the [locked] mark."""
    locked = locked or set()
    blocks: list[str] = []
    prose: list[str] = []
    items: list[str] = []
    marker: str | None = None
    counter = 0

    def mark(x: dict[str, Any]) -> str:
        return str(x.get("text") or "") + (f" {LOCKED_MARK}" if str(x.get("id")) in locked else "")

    def flush() -> None:
        nonlocal prose, items, counter
        if prose:
            blocks.append(" ".join(prose))
            prose = []
        if items:
            blocks.append("\n".join(items))
            items = []
            counter = 0

    for x in sentences:
        if not isinstance(x, dict) or not str(x.get("text") or "").strip():
            continue
        b = x.get("bullet")
        if b:
            if prose or (items and b != marker):
                flush()
            marker = b
            counter += 1
            items.append(f"{counter}. {mark(x)}" if b == NUMBER else f"- {mark(x)}")
        else:
            if items:
                flush()
            prose.append(mark(x))
    flush()
    return "\n\n".join(blocks)


# --------------------------------------------------------------------------- roles, links and figures


def assign_roles(headings: list[str]) -> list[str]:
    """One report role per section from the writer's headings, by the heading's words first and by position for the
    slots still unclaimed when there are four or more sections; everything else is a finding."""
    from . import report  # noqa: PLC0415

    fixed = {material.collapse(h).lower(): role for role, h in report.FIXED.items()}
    n = len(headings)
    roles: list[str | None] = [None] * n
    claimed: set[str] = set()
    for i, h in enumerate(headings):
        hl = material.collapse(h).lower()
        role: str | None = None
        if hl in fixed:
            role = fixed[hl]
        elif hl.startswith("what this data") or hl in ("data", "the data"):
            role = "data"
        elif "takeaway" in hl or hl == "summary" or TLDR_RE.match(hl or ""):
            role = "takeaways"
        elif hl.startswith("limitation") or hl.startswith("caveat"):
            role = "caveats"
        if role and role not in claimed:
            roles[i] = role
            claimed.add(role)
    if n >= 4:
        for idx, role in ((0, "data"), (1, "takeaways"), (n - 1, "caveats")):
            if role not in claimed and roles[idx] is None:
                roles[idx] = role
                claimed.add(role)
    return [r or "finding" for r in roles]


def link_takeaways(sections: list[dict[str, Any]]) -> None:
    """The `section` link of every takeaways sentence, the finding whose heading's words it shares most, when the share
    reaches LINK_MIN_OVERLAP; every other sentence's link is None."""
    findings = [(str(s["id"]), tokens(s.get("heading"))) for s in sections if s.get("role") == "finding"]
    for s in sections:
        for p in s.get("paragraphs") or []:
            for x in p.get("sentences") or []:
                x["section"] = None
                if s.get("role") != "takeaways" or not findings:
                    continue
                toks = tokens(x.get("text"))
                best_id, best = None, 0.0
                for fid, ht in findings:
                    if not ht:
                        continue
                    share = len(ht & toks) / len(ht)
                    if share > best:
                        best_id, best = fid, share
                    if share == 1.0:
                        break
                x["section"] = best_id if best_id and best >= LINK_MIN_OVERLAP else None


def figures(items: Any, valid: Any, para_ids: list[str], used: set[str]) -> list[dict[str, Any]]:
    """The stored figures of one section: one per chart- or table-bearing cell, its 1-based `after_paragraph` resolved
    to a
    paragraph id; a figure whose card shows no chart or table is dropped."""
    from . import report  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for f in items if isinstance(items, list) else []:
        if isinstance(f, str):
            f = {"cell": f}
        if not isinstance(f, dict):
            continue
        after = f.get("after_paragraph")
        if isinstance(after, str) and after.strip().isdigit():
            after = int(after)
        pid = None
        if isinstance(after, int) and not isinstance(after, bool) and after >= 1 and para_ids:
            pid = para_ids[min(after, len(para_ids)) - 1]
        cid = valid.artifact_id(f.get("cell"))
        if cid is None:
            log.info("document: figure on %r dropped: not a chart- or table-bearing cell", f.get("cell"))
            continue
        if cid in seen:
            continue
        seen.add(cid)
        out.append({"id": report._new_id(used), "cell": f"card:{cid}",
                    "caption": material.collapse(f.get("caption")) or valid.artifacts[cid], "after_paragraph": pid})
    return out


__all__ = ["ABBREVIATIONS", "BULLET", "NUMBER", "LOCKED_MARK", "PINNED_MARK", "TLDR_RE", "tokens", "unwrap_code_refs",
           "segment_units", "segment_body", "records_of", "sentence_units", "one_sentence", "body_of", "assign_roles",
           "link_takeaways", "figures"]
