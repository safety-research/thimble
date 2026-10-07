"""The report's shape and the checks every document's sentences share: the fixed sections and their roles, the writer's
markdown made into the stored document, ref validation, the analyst's text edits, comments across generations, and
the citation check that repairs a value ref by execution and tags what nothing shows. No model runs here."""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
from collections.abc import Iterable, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import cite, config, heal, material, notebook, refs, report_format
from .agents import check_refs
from .schemas import TAGS

log = logging.getLogger("thimble.report")

DOC_ID = "report"
ROLES = ("data", "takeaways", "finding", "uncertainty", "unused", "caveats")
TITLE_MAX_WORDS = 25
FIXED: dict[str, str] = {
    "data": "What this data is and what we analyzed",
    "takeaways": "Main takeaways",
    "uncertainty": "Uncertainty and competing explanations",
    "unused": "What was run but not used",
    "caveats": "Limitations",
}
BROKEN_PREFIX = "Not verified by execution"
QUIET_PREFIX = "No source found"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _cut(s: Any, n: int) -> str:
    return material.cut(s, n)


def _title_ok(title: str) -> bool:
    """Whether the title is non-empty and no longer than a headline."""
    n = len(title.split())
    return 0 < n <= TITLE_MAX_WORDS


def _new_id(used: set[str]) -> str:
    while True:
        i = secrets.token_hex(4)
        if i not in used:
            used.add(i)
            return i


_MARKUP_RE = re.compile(r"\[\[([^\[\]|]*)\|[^\[\]]*\]\]|\[\[[^\[\]]*\]\]")
# not before a period that starts a word: "their .yardopts file" and ".gov.uk" keep their space
_BEFORE_PUNCT_RE = re.compile(r"\s+([,;:!?)]|\.(?!\w))")


def plain_text(text: str) -> str:
    """A sentence as a reader sees it, the [[value|ref]] markup flattened to the value and bare refs removed."""
    return _BEFORE_PUNCT_RE.sub(r"\1", _collapse(_MARKUP_RE.sub(lambda m: m.group(1) or "", text or "")))


# --------------------------------------------------------------------------- refs


def _reflist(raw: Any) -> list[str]:
    """A model's `refs` value as bare refs: a list or one string, markup reduced to the ref side."""
    items = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
    out: list[str] = []
    for it in items:
        if not isinstance(it, str):
            continue
        s = it.strip()
        if s.startswith("[[") and s.endswith("]]"):
            inner = s[2:-2]
            s = (inner.split("|", 1)[1] if "|" in inner else inner).strip()
        if s:
            out.append(s)
    return out


class _Refs:
    """Validates refs against the workspace: a cell of one of its notebooks, a concept, a corpus file. Knows the cards
    that draw a figure, which a document's figure may show (`artifacts`, cell id to its title, by material.figure_kind).
    Every notebook group counts."""

    def __init__(self, c: str):
        ws = config.workspace_dir(c)
        self.cells: set[str] = set()
        self.artifacts: dict[str, str] = {}
        for info in notebook.list_notebooks(ws):
            nb = notebook.read_notebook(ws, info["id"])
            for cell in (nb or {}).get("cells", []):
                cid = str(cell.get("id") or "")
                if not cid:
                    continue
                self.cells.add(cid)
                if material.figure_kind(cell):
                    self.artifacts[cid] = _collapse(cell.get("title"))
        try:
            from . import concepts  # noqa: PLC0415

            self.concepts = {str(k.get("id")) for k in concepts.list_concepts(ws)}
        except Exception:  # noqa: BLE001
            self.concepts = set()
        try:
            self.corpus: Path | None = config.corpus_dir(c)
        except ValueError:
            self.corpus = None

    def _exists(self, rel: str) -> bool:
        if self.corpus is None:
            return False
        try:
            return config.safe_corpus_path(self.corpus, rel).exists()
        except ValueError:
            return False

    def ok(self, ref: str) -> bool:
        try:
            p = refs.parse_ref(ref)
        except ValueError:
            return False
        k = p["kind"]
        if k == "cell":
            return p["cell_id"] in self.cells
        if k == "concept":
            return p["concept_id"] in self.concepts
        if k in refs.FILE_KINDS:
            return self._exists(p["path"])
        return False

    def clean(self, raw: Any, text: str = "") -> list[str]:
        """The distinct valid refs among `raw` and those cited in `text`, in order."""
        out: list[str] = []
        for r in _reflist(raw) + refs.extract_refs(text or ""):
            if r not in out and self.ok(r):
                out.append(r)
        return out

    def artifact_id(self, raw: Any) -> str | None:
        """The id of the card that draws a figure `raw` names, as card:<id> (or cell:<id>), a span, markup or a bare id."""
        found = _reflist(raw)
        s = found[0] if found else ""
        cid: str | None = None
        try:
            p = refs.parse_ref(s)
            if p["kind"] == "cell":
                cid = p["cell_id"]
        except ValueError:
            pass
        if cid is None and s in self.artifacts:
            cid = s
        return cid if cid in self.artifacts else None


# --------------------------------------------------------------------------- the report from the writer's output


def _normalize(raw: dict[str, Any], valid: _Refs) -> dict[str, Any]:
    """The stored report from the `document` tool's input: sections in the writer's order, roles by heading then
    position,
    sentence records from each markdown body, figures on cards that draw one. 502 when nothing survives."""
    used: set[str] = set()
    wants_section: dict[str, str] = {}

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
        raw_notes = x.get("tag_notes") if isinstance(x.get("tag_notes"), dict) else {}
        notes = {str(k).strip().lower(): _collapse(v) for k, v in raw_notes.items()
                 if str(k).strip().lower() in tags and isinstance(v, str) and v.strip()}
        out = {"id": _new_id(used), "text": text, "refs": valid.clean(x.get("refs"), text), "tags": tags,
               "tag_notes": {t: notes[t] for t in tags if t in notes}, "section": None}
        if isinstance(x.get("section"), str) and x["section"].strip():
            wants_section[out["id"]] = _collapse(x["section"]).lower()
        return out

    def paragraph(p: Any) -> dict[str, Any] | None:
        items = p.get("sentences") if isinstance(p, dict) else p
        if isinstance(items, str):
            items = [items]
        if not isinstance(items, list):
            return None
        sentences = [q for q in (sentence(x) for x in items) if q]
        return {"id": _new_id(used), "sentences": sentences} if sentences else None

    from . import report_types  # noqa: PLC0415

    drafts: list[dict[str, Any]] = []
    raw_secs = [s for s in raw["sections"] if isinstance(s, dict)] if isinstance(raw.get("sections"), list) else []
    for i, sec in enumerate(raw_secs):
        paragraphs: list[dict[str, Any]] = []
        body = sec.get("body")
        if isinstance(body, list):
            body = "\n\n".join(str(b) for b in body if isinstance(b, str))
        if isinstance(body, str) and body.strip():
            for para in report_format.segment_units(body):
                paragraphs.append({"id": _new_id(used), "sentences": report_format.records_of(para, valid, used, section=None)})
        raw_paras = sec.get("paragraphs")
        if isinstance(raw_paras, str):
            raw_paras = [raw_paras]
        for p in raw_paras if isinstance(raw_paras, list) else []:
            q = paragraph(p)
            if q:
                paragraphs.append(q)
        if not paragraphs and not report_types.over_subheading(raw_secs, i):
            continue
        drafts.append({"heading": _collapse(sec.get("heading")), "level": report_types._level(sec.get("level")),
                       "paragraphs": paragraphs, "figures_raw": sec.get("figures")})
    if not drafts:
        raise HTTPException(502, "the report model produced no sentences")
    roles = report_format.assign_roles([d["heading"] for d in drafts])
    sections: list[dict[str, Any]] = []
    for i, (d, role) in enumerate(zip(drafts, roles)):
        para_ids = [str(p["id"]) for p in d["paragraphs"]]
        # Text before the first `## ` is the document's opening and keeps no heading, since a fixed one would misname
        # it.
        heading = d["heading"] or ("" if i == 0 else FIXED.get(role, "Section"))
        sections.append({"id": _new_id(used), "role": role, "heading": heading,
                         "paragraphs": d["paragraphs"], "figures": report_format.figures(d["figures_raw"], valid, para_ids, used),
                         **({"level": d["level"]} if d["level"] > 2 else {})})
    report_format.link_takeaways(sections)
    findings = [sec for sec in sections if sec["role"] == "finding"]
    by_heading: dict[str, str] = {}
    for f in findings:
        by_heading.setdefault(f["heading"].lower(), f["id"])
    for sec in sections:
        for p in sec["paragraphs"]:
            for x in p["sentences"]:
                want = wants_section.get(x["id"])
                if want:
                    x["section"] = by_heading.get(want)
    title = _collapse(raw.get("title")) or (findings[0]["heading"] if findings else "") or "Report"
    return {"id": DOC_ID, "title": title, "title_ok": _title_ok(title), "sections": sections, "comments": []}


# --------------------------------------------------------------------------- the analyst's text edits
# An edit locks nothing: only a block the analyst locks is locked (report_types.set_block_lock).


def _replace_text(node: dict[str, Any], key: str, new: str, by: str, *, valid: "_Refs | None" = None,
                  history: str = "history", **entry_fields: Any) -> None:
    """`node[key]` takes `new`, the previous value under `node[history]`; with `valid` the node's refs are re-derived
    from the new text and the entry keeps the refs as they were."""
    entry: dict[str, Any] = {"text": node.get(key) or "", "ts": _now(), "by": by, **entry_fields}
    if valid is not None:
        entry["refs"] = list(node.get("refs") or [])
    node.setdefault(history, []).append(entry)
    node[key] = new
    if valid is not None:
        node["refs"] = valid.clean(list(node.get("refs") or []), new)


def _put_text(node: dict[str, Any], key: str, new: str, *, undo: bool = False, valid: "_Refs | None" = None,
              history: str = "history", edited_by: str = "edited_by") -> bool:
    """The analyst's edit of `node[key]`: the same text changes nothing; with `undo`, the newest history entry is
    popped;
    anything else records the previous text under history. True when the text changed."""
    if new == (node.get(key) or ""):
        return False
    hist = node.get(history)
    if undo and isinstance(hist, list) and hist and isinstance(hist[-1], dict) and hist[-1].get("text") == new:
        entry = hist.pop()
        node[key] = new
        if valid is not None:
            saved = entry.get("refs")
            node["refs"] = list(saved) if isinstance(saved, list) else valid.clean(list(node.get("refs") or []), new)
        if not hist:
            node.pop(history, None)
            node.pop(edited_by, None)
        return True
    _replace_text(node, key, new, "analyst", valid=valid, history=history)
    node[edited_by] = "analyst"
    return True


# --------------------------------------------------------------------------- comments across generations

CHECK_AUTHOR = "check"  # a report check's comment (checks.py), which names its check as `check`
LEGACY_AUTHOR = "verifier"  # a verify agent's comment, read as its built-in check's (report_types.read_doc)
RESOLUTION_SUPERSEDED = "superseded"
SETTLED_STATUS = "dismissed"
RESOLUTION_FIELDS = ("resolution", "superseded_by", "superseded_generation")


def settle_carried_comment(cm: dict[str, Any], *, anchored: bool, generation: int) -> dict[str, Any]:
    """A comment carried onto a new generation: one whose passage survived carries as it is, an open check comment on a
    rewritten passage is superseded, and everything else stays as it was. Mutates and returns `cm`."""
    if (cm.get("status") or "open") == "open" and not anchored and (cm.get("check") or cm.get("author") == CHECK_AUTHOR):
        cm["status"] = SETTLED_STATUS
        cm["resolution"] = RESOLUTION_SUPERSEDED
        cm["superseded_generation"] = generation
        cm.setdefault("superseded_by", None)
    return cm


def reopen_comment(cm: dict[str, Any]) -> bool:
    """A dismissed comment back to open, its resolution fields cleared; False when it was not dismissed."""
    if cm.get("status") != SETTLED_STATUS:
        return False
    cm["status"] = "open"
    for k in RESOLUTION_FIELDS:
        cm.pop(k, None)
    return True


# --------------------------------------------------------------------------- the citation check


def _value_refs(text: str) -> list[tuple[str, str]]:
    """[(display, ref)] for every [[display|ref]] in `text`."""
    out: list[tuple[str, str]] = []
    for m in refs._BRACKETS.finditer(text or ""):
        inner = m.group(1)
        if "|" in inner:
            display, ref = inner.split("|", 1)
            if display.strip() and ref.strip():
                out.append((display.strip(), ref.strip()))
    return out


def _value_matches(display: str, excerpt: str) -> bool:
    """Whether the display value appears in the excerpt (cite.value_in): a number as a whole token, the same value or
    the token with only its shown decimals dropped, and anything else as a comma-insensitive substring."""
    return cite.value_in(display, excerpt)


def _cell_of(ref: str) -> str | None:
    m = re.match(r"^" + cite.CARD_RE + r"([A-Za-z0-9_-]+)", str(ref or ""))
    return m.group(1) if m else None


def _better_span_for_value(ws: Path, ref: str, display: str, text: str = "") -> str | None:
    """A span of the same cell that shows `display` when `ref` does not, else None; never a td of another row when the
    sentence `text` names the row `ref` cites (cite.off_named_row)."""
    cid = _cell_of(ref)
    if not cid:
        return None
    hit = notebook.find_cell(ws, cid)
    if hit is None:
        return None
    cell = hit[1]
    m = refs._CELL_LINE.match(ref)
    if m:
        out_i, line_n = int(m.group(2)), int(m.group(3))
        end_n = int(m.group(4)) if m.group(4) else line_n
        full = notebook.output_full_text(ws, cell, out_i)
        lines = full.splitlines() if full else []
        if 1 <= line_n <= len(lines) and any(_value_matches(display, ln) for ln in lines[line_n - 1 : max(line_n, end_n)]):
            return None
        better = next((i + 1 for i, ln in enumerate(lines) if _value_matches(display, ln)), None)
        return f"card:{cid}@out{out_i}#L{better}" if better and better != line_n else None
    m = refs._CELL_TD.match(ref)
    if m:
        col, row = m.group(2), m.group(3)
        here = cite.find_td(cell.get("outputs"), col, row)
        if here is not None and _value_matches(display, here[0]):
            return None
        matches: list[tuple[str, str]] = []
        for b in cell.get("outputs") or []:
            html = cite.table_html(b)  # a table, or the inline rows a chart draws
            if html:
                for c_, r_, v in cite.table_cells(html):
                    if _value_matches(display, v) and (c_, r_) not in matches:
                        matches.append((c_, r_))
        if len(matches) == 1:
            new_ref = cite.td_ref(cid, *matches[0])
            if new_ref and cite.off_named_row(ref, new_ref, text):
                return None
            return new_ref if new_ref and new_ref != ref else None
    return None


def repair_span_refs(ws: Path, sentences: Iterable[dict[str, Any]]) -> int:
    """A value ref whose line or table cell does not show the value moves to the one place of the same output that
    does, in place. Returns the number of refs changed."""
    moved = 0
    for x in sentences:
        text = str(x.get("text") or "")
        refs_list = list(x.get("refs") or [])
        for display, r in _value_refs(text):
            new_ref = _better_span_for_value(ws, r, display, text)
            if not new_ref:
                continue
            marker = f"[[{display}|{r}]]"
            if marker not in text:
                continue
            text = text.replace(marker, f"[[{display}|{new_ref}]]")
            refs_list = [new_ref if rr == r else rr for rr in refs_list]
            moved += 1
        if text != x.get("text"):
            x["text"] = text
        x["refs"] = refs_list
    return moved


def demote_gone_spans(ws: Path, sentences: Iterable[dict[str, Any]], failed: Sequence[dict[str, Any]]) -> int:
    """A plain span ref whose target is gone becomes a ref to its cell, a receipt that exists. Returns the number
    changed."""
    gone = {(str(f.get("sentence_id")), str(f.get("ref"))) for f in failed if f.get("span_missing") and not f.get("value")}
    if not gone:
        return 0
    moved = 0
    for x in sentences:
        sid = str(x.get("id"))
        text = str(x.get("text") or "")
        refs_list = list(x.get("refs") or [])
        for r in list(dict.fromkeys(refs_list + refs.extract_refs(text))):
            if (sid, r) not in gone:
                continue
            cid = _cell_of(r)
            if not cid or notebook.find_cell(ws, cid) is None:
                continue
            new_ref = f"card:{cid}"
            text = text.replace(f"[[{r}]]", f"[[{new_ref}]]")
            refs_list = list(dict.fromkeys(new_ref if rr == r else rr for rr in refs_list))
            moved += 1
        if text != x.get("text"):
            x["text"] = text
        x["refs"] = refs_list
    return moved


def broken_note(items: Sequence[str], sources: Sequence[str] = (), said: Sequence[str] = ()) -> str:
    """The note of a sentence whose cited place shows another value."""
    base = f"{BROKEN_PREFIX}: {', '.join(items)} did not resolve to what this sentence states."
    if sources:
        base += f" The cited place shows {', '.join(dict.fromkeys(sources))}."
    if said:
        base += f" Corrected in place: the sentence said {', '.join(dict.fromkeys(said))}."
    return base


def quiet_note(items: Sequence[str]) -> str:
    """The note of a sentence whose ref is gone or whose number nothing shows."""
    return f"{QUIET_PREFIX}: {', '.join(items)} did not resolve to a place that shows this."


def unverified_kind(x: dict[str, Any]) -> str | None:
    """broken, quiet or uncited for an unverified sentence, None for any other."""
    if "unverified" not in (x.get("tags") or []):
        return None
    note = str((x.get("tag_notes") or {}).get("unverified") or "")
    return "broken" if note.startswith(BROKEN_PREFIX) else "quiet" if note.startswith(QUIET_PREFIX) else "uncited"


def _load_cell(ws: Path):
    def load(cid: str) -> dict | None:
        hit = notebook.find_cell(ws, cid)
        if hit is None:
            return None
        cell = hit[1]
        return {**cell, "outputs": notebook.hydrate_outputs(ws, cell.get("outputs"))} if cell.get("outputs") else cell
    return load


def _whole_notebook(ws: Path):
    def cells() -> list[dict]:
        out: list[dict] = []
        for info in notebook.list_notebooks(ws):
            nb = notebook.read_notebook(ws, info["id"])
            out += [x for x in (nb or {}).get("cells") or [] if isinstance(x, dict)]
        return heal.newest_first(out)
    return cells


def _source_numbers(excerpt: str) -> str | None:
    nums = cite._NUM_RE.findall(excerpt)
    return ", ".join(nums[:3]) if nums else None


async def heal_sentences(c: str, sentences: list[dict[str, Any]], *, unwrap: bool = False) -> int:
    """The healing pass over sentence records, in place: a value ref whose place does not show its value is re-pointed
    at
    the one place that does (or unwrapped when `unwrap`), and a contradicting place is marked. Returns the number of
    sentences whose text changed."""
    corpus = config.corpus_dir(c)
    ws = config.workspace_dir(c)
    load, whole = _load_cell(ws), _whole_notebook(ws)
    cache = heal.Cache()
    changed = 0
    for x in sentences:
        text = str(x.get("text") or "")
        if "|" not in text:
            x.pop("healed", None)
            continue
        external: dict[tuple[str, str], Any] = {}
        for display, ref in _value_refs(text):
            if cite.is_card_ref(ref) or (display, ref) in external:
                continue
            try:
                out = await asyncio.to_thread(refs.resolve, corpus, ref)
            except Exception as e:  # noqa: BLE001
                external[(display, ref)] = f"does not resolve: {getattr(e, 'detail', None) or e}"
                continue
            if (out.get("meta") or {}).get("span_missing"):
                external[(display, ref)] = "the cited span is gone"
                continue
            excerpt = str(out.get("excerpt") or "")
            external[(display, ref)] = None if _value_matches(display, excerpt) else {"why": "the value is not at this reference", "source": _source_numbers(excerpt)}

        prior = x.get("healed") if isinstance(x.get("healed"), list) else ()
        res = await heal.heal(text, load=load, notebook=whole, analyst=x.get("edited_by") == "analyst",
                              external=external, unwrap=unwrap, prior=prior, cache=cache)
        records = [ch.record() for ch in res.changes if ch.how != heal.KEPT]
        if records:
            x["healed"] = records
        else:
            x.pop("healed", None)
        if res.text != text:
            x["text"] = res.text
            refs_list = list(x.get("refs") or [])
            for ch in res.changes:
                if ch.to and ch.to != ch.ref:
                    refs_list = [ch.to if r == ch.ref else r for r in refs_list]
                elif ch.to is None and ch.ref in refs_list and ch.ref not in refs.extract_refs(res.text):
                    refs_list.remove(ch.ref)
            x["refs"] = list(dict.fromkeys(r for r in refs_list if r))
            changed += 1
    return changed


async def verify_and_tag(c: str, sentences: list[dict[str, Any]]) -> dict[str, Any]:
    """The citation check over sentence records, in place, run by every save: repairs and the healing pass, then every
    ref
    re-resolved and every value ref's display checked against its excerpt; what still fails is tagged `unverified`
    with a
    note. Returns {checked, failed, repaired}."""
    corpus = config.corpus_dir(c)
    ws = config.workspace_dir(c)
    repaired = repair_span_refs(ws, sentences)
    repaired += await heal_sentences(c, sentences)
    pairs: list[tuple[str, str]] = []
    values: list[tuple[str, str, str]] = []
    for x in sentences:
        sid = str(x.get("id"))
        text = str(x.get("text") or "")
        seen: list[str] = []
        for r in list(x.get("refs") or []) + refs.extract_refs(text):
            if isinstance(r, str) and r and r not in seen:
                seen.append(r)
                pairs.append((sid, r))
        for display, r in _value_refs(text):
            values.append((sid, r, display))
    distinct = list(dict.fromkeys(r for _, r in pairs))
    _, broken = await check_refs(c, distinct)
    broken_set = set(broken)
    failed: list[dict[str, Any]] = [{"sentence_id": sid, "ref": r} for sid, r in pairs if r in broken_set]

    async def resolved(r: str) -> dict[str, Any] | None:
        try:
            return await asyncio.to_thread(refs.resolve, corpus, r)
        except Exception:  # noqa: BLE001
            return None

    unique = list(dict.fromkeys(r for _, r, _ in values if r not in broken_set))
    outs = dict(zip(unique, await asyncio.gather(*(resolved(r) for r in unique))))
    for sid, r, display in values:
        if r in broken_set:
            continue
        out = outs.get(r)
        exc = None if out is None else str(out.get("excerpt") or "")
        if exc is None or not _value_matches(display, exc):
            failed.append({"sentence_id": sid, "ref": r, "value": display})
    value_pairs = {(sid, r) for sid, r, _ in values}
    spans = [r for r in distinct if r not in broken_set and cite.is_card_ref(r) and ("#" in r or "@out" in r)]
    span_out = dict(zip(spans, await asyncio.gather(*(resolved(r) for r in spans))))
    gone = [{"sentence_id": sid, "ref": r, "span_missing": True} for sid, r in pairs
            if (sid, r) not in value_pairs and span_out.get(r) is not None and (span_out[r].get("meta") or {}).get("span_missing")]
    if gone:
        repaired += demote_gone_spans(ws, sentences, gone)
    unwrapped = 0
    for x in sentences:
        sid = str(x.get("id"))
        for ch in x.get("healed") or []:
            if ch.get("state") == heal.QUIET and not ch.get("to"):
                unwrapped += 1
                failed.append({"sentence_id": sid, "ref": ch.get("ref"), "value": ch.get("value"), "quiet": True})
            elif ch.get("state") == heal.CONTRADICTED:
                ref, shown = ch.get("to") or ch.get("ref"), ch.get("was") or ch.get("value")
                failed = [f for f in failed if not (f["sentence_id"] == sid and f.get("ref") == ref and f.get("value") == ch.get("value") and not f.get("contradicted"))]
                failed.append({"sentence_id": sid, "ref": ref, "value": shown, "contradicted": True, "source": ch.get("source"),
                               "was": ch.get("was") if ch.get("corrected") else None})
    by_sentence: dict[str, dict[str, list[str]]] = {}
    for f in failed:
        rec = by_sentence.setdefault(f["sentence_id"], {"broken": [], "quiet": [], "sources": [], "said": []})
        if f.get("contradicted"):
            if f["ref"] not in rec["broken"]:
                rec["broken"].append(f["ref"])
            if f.get("source"):
                rec["sources"].append(str(f["source"]))
            if f.get("was"):
                rec["said"].append(str(f["was"]))
        else:
            # a value its cited place does not show is named with the place, so the note says which value is meant
            item = (str(f.get("value") or f.get("ref") or "") if f.get("quiet")
                    else f"{f['ref']} (for “{f['value']}”)" if f.get("value") else str(f["ref"]))
            if item and item not in rec["quiet"]:
                rec["quiet"].append(item)
    for x in sentences:
        rec = by_sentence.get(str(x.get("id")))
        tags = [t for t in (x.get("tags") or []) if t != "unverified"]
        notes = x.setdefault("tag_notes", {})
        if not rec:
            if unverified_kind(x) in ("broken", "quiet"):
                notes.pop("unverified", None)
                x["tags"] = tags
            continue
        tags.append("unverified")
        x["tags"] = [t for t in TAGS if t in tags]
        notes["unverified"] = broken_note(rec["broken"], rec["sources"], rec["said"]) if rec["broken"] else quiet_note(rec["quiet"])
    return {"checked": len(pairs) + unwrapped, "failed": failed, "repaired": repaired}
