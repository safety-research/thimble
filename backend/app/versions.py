"""The revision history of a document: one record per generation at investigations/<inv>/versions/<slug>/<n>.json with
who asked, the instruction, a summary of what changed and the previous generation, and the list a reader sees.

One writer run is one generation: each later save of the run updates it in place, the replaced save kept as a
revision at versions/<slug>/<n>.revisions.json. In a legacy workspace with a generation per save, consecutive
generations of one writer's chat fold into the newest (legacy_revisions)."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import investigation
from .ledger import read_json, write_json

log = logging.getLogger(__name__)

DIR = "versions"
WHAT_CHANGED = "what changed"  # the heading of the writer's closing section
UNIT_KEYS = ("sections", "slides", "beats")
UNIT_NOUNS = {"sections": "section", "slides": "slide", "beats": "beat"}
SUMMARY_LINES = 5
LINE_CHARS = 500
NAMES_CAP = 3
FIRST_SOURCE = "first"
LEAN_KEYS = ("snapshot", "source")
REVISIONS_SUFFIX = ".revisions"
SOURCE_BUTTON, SOURCE_CHAT, SOURCE_THREAD = "button", "chat", "thread"

_BULLET_RE = re.compile(r"^\s*(?:[-*+•]|\d{1,2}[.)])\s+")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+\S")
_MARK_RE = re.compile(r"\[\[([^\[\]|]*)\|[^\[\]]*\]\]|\[\[[^\[\]]*\]\]")
# not before a period that starts a word: "their .yardopts file" and ".gov.uk" keep their space
_BEFORE_PUNCT_RE = re.compile(r"\s+([,;:!?)]|\.(?!\w))")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _norm_heading(h: Any) -> str:
    s = re.sub(r"^\s*#{1,6}\s*", "", str(h or ""))
    s = s.replace("`", "").replace("*", "").replace("_", " ")
    s = re.sub(r"[\s:.\-–—]+$", "", s)
    return " ".join(s.split()).lower()


def plain(text: Any) -> str:
    """A sentence's text without its [[...]] markup, collapsed."""
    stripped = " ".join(_MARK_RE.sub(lambda m: m.group(1) or "", str(text or "")).split())
    return _BEFORE_PUNCT_RE.sub(r"\1", stripped)


def _cut(line: str) -> str:
    if len(line) <= LINE_CHARS:
        return line
    head = line[:LINE_CHARS]
    sp = head.rfind(" ")
    return (head[:sp] if sp > LINE_CHARS // 2 else head).rstrip(" ,;:") + "…"


def _lines_of(unit: dict[str, Any]) -> list[str]:
    """The lines of a raw unit: its markdown body line by line, else the texts of its sentence objects."""
    out: list[str] = []
    body = unit.get("body")
    if isinstance(body, str):
        for raw in body.splitlines():
            line = plain(_BULLET_RE.sub("", raw))
            if line:
                out.append(_cut(line))
    else:
        paras = unit.get("paragraphs") if isinstance(unit.get("paragraphs"), list) else [unit]
        for p in paras:
            for x in (p.get("sentences") or []) if isinstance(p, dict) else []:
                line = plain(x.get("text") if isinstance(x, dict) else x)
                if line:
                    out.append(_cut(line))
    return out[:SUMMARY_LINES]


def _pop_body_tail(unit: dict[str, Any]) -> list[str]:
    """Cut a closing "What changed" block from a unit's markdown body and return its lines."""
    body = unit.get("body")
    if not isinstance(body, str):
        return []
    lines = body.splitlines()
    for i in range(len(lines) - 1, -1, -1):
        if _HEADING_RE.match(lines[i]) and _norm_heading(lines[i]) == WHAT_CHANGED:
            head = "\n".join(lines[:i]).rstrip()
            if not head.strip():
                return []
            unit["body"] = head
            return _lines_of({"body": "\n".join(lines[i + 1:])})
    return []


def pop_what_changed(raw: Any) -> list[str]:
    """Remove the writer's closing "What changed" block from its raw output, in place, and return its lines. Only the
    last unit is looked at, and it is dropped whole when it is the block, unless it is the whole document."""
    if not isinstance(raw, dict):
        return []
    for key in UNIT_KEYS:
        items = raw.get(key)
        if not isinstance(items, list) or not items:
            continue
        last = items[-1]
        if not isinstance(last, dict):
            return []
        if _norm_heading(last.get("heading") or last.get("title")) == WHAT_CHANGED:
            if len(items) < 2:
                return []
            lines = _lines_of(last)
            del items[-1]
            return lines
        return _pop_body_tail(last)
    return []


# --------------------------------------------------------------------------- the fallback summary


def _units(doc: dict[str, Any]) -> tuple[str, list[tuple[tuple[str, int], str, str]]]:
    from . import report_types  # noqa: PLC0415

    noun = next((UNIT_NOUNS[k] for k in UNIT_KEYS if isinstance(doc.get(k), list)), "section")
    out: list[tuple[tuple[str, int], str, str]] = []
    seen: dict[str, int] = {}
    for u in report_types.units(doc):
        heading = str(u.get("heading") or "")
        texts = [t for t in (plain(x.get("text")) for x in report_types.unit_sentences(u)) if t]
        text = " ".join(texts)
        name = _norm_heading(heading) or text[:60].lower()
        seen[name] = seen.get(name, 0) + 1
        # a unit with no heading is named by its first sentence whole, never cut mid-word
        out.append(((name, seen[name]), heading or (texts[0] if texts else ""), text))
    return noun, out


def _names(items: list[str]) -> str:
    shown = [f"“{x}”" for x in items[:NAMES_CAP]]
    more = len(items) - len(shown)
    return ", ".join(shown) + (f" and {more} more" if more > 0 else "")


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def fallback_summary(prev: dict[str, Any] | None, doc: dict[str, Any]) -> list[str]:
    """A section-level diff in plain lines: the title, the units added, removed and reworded, and how many kept their
    text."""
    noun, new = _units(doc)
    _, old = _units(prev or {})
    old_by = {k: t for k, _, t in old}
    new_by = {k: t for k, _, t in new}
    added = [h for k, h, _ in new if k not in old_by]
    removed = [h for k, h, _ in old if k not in new_by]
    reworded = [h for k, h, t in new if k in old_by and " ".join(old_by[k].split()) != " ".join(t.split())]
    kept = sum(1 for k, _, t in new if k in old_by and " ".join(old_by[k].split()) == " ".join(t.split()))
    lines: list[str] = []
    if prev is not None and plain(prev.get("title")) != plain(doc.get("title")):
        lines.append(f"The title changed to “{plain(doc.get('title'))}”.")
    if added:
        lines.append(f"{_plural(len(added), noun)} added: {_names(added)}.")
    if removed:
        lines.append(f"{_plural(len(removed), noun)} removed: {_names(removed)}.")
    if reworded:
        lines.append(f"{_plural(len(reworded), noun)} reworded: {_names(reworded)}.")
    if not lines:
        return [f"No {noun} changed."]
    if kept:
        lines.append(f"{_plural(kept, noun)} kept as written.")
    return lines[:SUMMARY_LINES]


# --------------------------------------------------------------------------- the records


def versions_dir(c: str, inv_id: str, slug: str) -> Path:
    return investigation.inv_dir(c, inv_id) / DIR / slug


def _path(c: str, inv_id: str, slug: str, n: int) -> Path:
    return versions_dir(c, inv_id, slug) / f"{int(n)}.json"


def _lean(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if k not in LEAN_KEYS}


def _generation(doc: dict[str, Any] | None) -> int:
    try:
        return int((doc or {}).get("generation") or 0)
    except (TypeError, ValueError):
        return 0


def record(c: str, inv_id: str, slug: str, prev: dict[str, Any] | None, doc: Any, *, source: str | None,
           instructions: str | None, run: str | None = None) -> dict[str, Any] | None:
    """Write the version record of a revision that landed; None for a first generation, a failed one or anything that
    is not a document. Never raises."""
    try:
        if not isinstance(doc, dict) or prev is None or doc.get("generation_failed") or doc.get("status") == "rate_limited":
            return None
        n, before = _generation(doc), _generation(prev)
        if n <= before or n < 2:
            return None
        from . import revise_diff  # noqa: PLC0415

        writer_lines = [str(x) for x in (doc.get("what_changed") or []) if str(x).strip()]
        rec = {
            "n": n, "ts": str(doc.get("generated_at") or _now()), "run": run, "source": source or "",
            "instructions": revise_diff.typed_instruction(instructions),
            "summary": writer_lines[:SUMMARY_LINES] or fallback_summary(prev, doc),
            "summary_from": "writer" if writer_lines else "diff",
            "previous_generation": before, "previous": _lean(prev),
            "model": doc.get("model"), "model_requested": doc.get("model_requested"), "effort": doc.get("effort"),
        }
        path_ = _path(c, inv_id, slug, n)
        path_.parent.mkdir(parents=True, exist_ok=True)
        write_json(path_, rec)
        return rec
    except Exception:  # noqa: BLE001
        log.exception("%s/%s: the version record could not be written", c, slug)
        return None


def revisions_path(c: str, inv_id: str, slug: str, n: int) -> Path:
    return versions_dir(c, inv_id, slug) / f"{int(n)}{REVISIONS_SUFFIX}.json"


def _revision_file(c: str, inv_id: str, slug: str, n: int) -> dict[str, Any] | None:
    rec = read_json(revisions_path(c, inv_id, slug, n), None)
    return rec if isinstance(rec, dict) and isinstance(rec.get("revisions"), list) else None


def add_revision(c: str, inv_id: str, slug: str, replaced: dict[str, Any], *, run: str | None) -> int | None:
    """Keep `replaced`, a save of the current generation that a later save of the same writer run replaces, as that
    generation's next revision; returns its number, None when it could not be written. Never raises."""
    try:
        n = max(_generation(replaced), 1)
        rec = _revision_file(c, inv_id, slug, n) or {"n": n, "run": run, "revisions": []}
        i = len(rec["revisions"]) + 1
        words = replaced.get("words")
        if not isinstance(words, (int, float)):
            from . import report_types  # noqa: PLC0415

            words = report_types.doc_words(replaced)
        rec["revisions"].append({"i": i, "ts": str(replaced.get("generated_at") or _now()), "words": int(words),
                                 "doc": _lean(replaced)})
        path_ = revisions_path(c, inv_id, slug, n)
        path_.parent.mkdir(parents=True, exist_ok=True)
        write_json(path_, rec)
        return i
    except Exception:  # noqa: BLE001
        log.exception("%s/%s: a revision could not be kept", c, slug)
        return None


def previous_of(c: str, inv_id: str, slug: str, n: int) -> dict[str, Any] | None:
    """Generation n - 1 as it stood, from generation n's record; None for the first or when no record holds it."""
    rec = _records(c, inv_id, slug).get(int(n))
    prev = rec.get("previous") if isinstance(rec, dict) else None
    return prev if isinstance(prev, dict) else None


def record_run(c: str, inv_id: str, slug: str, n: int) -> str | None:
    rec = _records(c, inv_id, slug).get(int(n))
    return str(rec["run"]) if isinstance(rec, dict) and rec.get("run") else None


def _records(c: str, inv_id: str, slug: str) -> dict[int, dict[str, Any]]:
    d = versions_dir(c, inv_id, slug)
    out: dict[int, dict[str, Any]] = {}
    if not d.is_dir():
        return out
    for p in d.glob("*.json"):
        if p.stem.isdigit():
            rec = read_json(p, None)
            if isinstance(rec, dict):
                out[int(p.stem)] = rec
    return out


def _entry(n: int, *, ts: Any, source: Any, instructions: Any, summary: Any, current: bool, available: bool,
           summary_from: Any = None, run: Any = None) -> dict[str, Any]:
    return {"n": n, "ts": str(ts or ""), "source": str(source or ""), "instructions": instructions if isinstance(instructions, str) and instructions.strip() else None,
            "summary": [str(x) for x in (summary or []) if str(x).strip()], "summary_from": summary_from, "run": run,
            "current": current, "available": available, "words": None, "writer": None, "revisions": []}


def _when(ts: Any) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(ts or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _writer_spans(c: str, slug: str) -> list[tuple[datetime, datetime | None, str]]:
    """(start, end or None while it runs, chat id) of each writer session of the document: a generation saved inside
    one was its writer's, though the save comes through the terminal's shim and is stamped `terminal`."""
    from . import agents  # noqa: PLC0415

    out: list[tuple[datetime, datetime | None, str]] = []
    try:
        metas = agents.list_chats(c)
    except Exception:  # noqa: BLE001
        log.debug("%s: the chats could not be read for the history", c, exc_info=True)
        return out
    for m in metas:
        start = _when(m.get("created_at"))
        if m.get("role") != "writer" or str(m.get("doc") or "") != slug or start is None:
            continue
        out.append((start, _when(m.get("ts_end")), str(m.get("id") or "")))
    return out


def _writer_of(spans: list[tuple[datetime, datetime | None, str]], ts: Any) -> str | None:
    t = _when(ts)
    if t is None:
        return None
    hits = [(start, cid) for start, end, cid in spans if start <= t and (end is None or t <= end)]
    return max(hits)[1] if hits else None


def history(c: str, inv_id: str, slug: str, doc: dict[str, Any]) -> dict[str, Any]:
    """{slug, generation, versions}: one entry per generation, newest first, `available` saying whether its text can
    be shown, `words` its length (None when its text is gone) and `writer` the writer's chat it was saved in, if any."""
    recs = _records(c, inv_id, slug)
    current = max(_generation(doc), 1)
    out: list[dict[str, Any]] = []
    for k in range(current, 0, -1):
        rec = recs.get(k)
        available = k == current or isinstance((recs.get(k + 1) or {}).get("previous"), dict)
        if rec is not None:
            out.append(_entry(k, ts=rec.get("ts"), source=rec.get("source"), instructions=rec.get("instructions"), summary=rec.get("summary"),
                              summary_from=rec.get("summary_from"), run=rec.get("run"), current=k == current, available=available))
        elif k == current:
            out.append(_entry(k, ts=doc.get("generated_at"), source=FIRST_SOURCE if k == 1 else "", instructions=doc.get("instructions"),
                              summary=doc.get("what_changed"), summary_from="writer" if doc.get("what_changed") else None,
                              current=True, available=True))
        else:
            nxt = recs.get(k + 1)
            prev = nxt.get("previous") if isinstance(nxt, dict) else None
            if isinstance(prev, dict):
                out.append(_entry(k, ts=prev.get("generated_at"), source=FIRST_SOURCE if k == 1 else "", instructions=prev.get("instructions"),
                                  summary=prev.get("what_changed"), summary_from="writer" if prev.get("what_changed") else None,
                                  current=False, available=True))
            else:
                out.append(_entry(k, ts=None, source=FIRST_SOURCE if k == 1 else "", instructions=None, summary=None, current=False, available=False))
    # each entry's length and, for a save made inside a writer's session, that writer's chat
    from . import report_types  # noqa: PLC0415

    spans = _writer_spans(c, slug)
    for e in out:
        k = e["n"]
        text = doc if k == current else (recs.get(k + 1) or {}).get("previous")
        if isinstance(text, dict):
            words = text.get("words")
            e["words"] = int(words) if isinstance(words, (int, float)) else report_types.doc_words(text)
        if e["source"] != "analyst":
            e["writer"] = _writer_of(spans, e["ts"])
        rev = _revision_file(c, inv_id, slug, k)
        if rev is not None:
            e["revisions"] = [{"i": int(r.get("i") or j + 1), "ts": str(r.get("ts") or ""), "words": r.get("words"),
                               "available": isinstance(r.get("doc"), dict), "generation": None}
                              for j, r in enumerate(rev["revisions"]) if isinstance(r, dict)]
        # a section diff is measured again from the texts kept
        if e["summary_from"] == "diff" and k > 1:
            before, after = _text_of(k - 1, recs, doc, current), _text_of(k, recs, doc, current)
            if before is not None and after is not None:
                e["summary"] = fallback_summary(before, after)
    return {"slug": slug, "generation": current, "versions": legacy_revisions(out, recs, doc, current)}


def _text_of(k: int, recs: dict[int, dict[str, Any]], doc: dict[str, Any], current: int) -> dict[str, Any] | None:
    text = doc if k == current else (recs.get(k + 1) or {}).get("previous")
    return text if isinstance(text, dict) else None


def legacy_revisions(out: list[dict[str, Any]], recs: dict[int, dict[str, Any]], doc: dict[str, Any],
                     current: int) -> list[dict[str, Any]]:
    """The history of a legacy workspace where every save was a generation: consecutive generations saved in one
    writer's
    chat fold into the newest of them, the older ones its revisions, oldest first."""
    folded: list[dict[str, Any]] = []
    for e in out:  # newest first
        top = folded[-1] if folded else None
        if (top is not None and e["writer"] and top["writer"] == e["writer"] and not e["revisions"]
                and e["source"] != "analyst" and not any(r["generation"] is None for r in top["revisions"])):
            top["revisions"].insert(0, {"i": 0, "ts": e["ts"], "words": e["words"], "available": e["available"],
                                        "generation": e["n"]})
            top["_first"] = e
            continue
        folded.append(e)
    for e in folded:
        first = e.pop("_first", None)
        if first is None:
            continue
        for j, r in enumerate(e["revisions"]):
            r["i"] = j + 1
        e["instructions"] = first["instructions"] or e["instructions"]
        e["source"] = first["source"] or e["source"]
        before = _text_of(first["n"] - 1, recs, doc, current) if first["n"] > 1 else None
        after = _text_of(e["n"], recs, doc, current)
        if first["n"] <= 1:
            e["summary"], e["summary_from"] = [], None
        elif before is not None and after is not None:
            e["summary"], e["summary_from"] = fallback_summary(before, after), "diff"
    return folded


def revision_of(c: str, inv_id: str, slug: str, n: int, i: int, doc: dict[str, Any]) -> dict[str, Any]:
    """Revision `i` (from 1, oldest first) of generation `n`: an earlier save of its writer run, or a folded legacy
    generation; 404 when none."""
    rev = _revision_file(c, inv_id, slug, n)
    if rev is not None:
        hit = next((r for r in rev["revisions"] if isinstance(r, dict) and int(r.get("i") or 0) == int(i)), None)
        if isinstance(hit, dict) and isinstance(hit.get("doc"), dict):
            return hit["doc"]
        raise HTTPException(404, f"no revision {i} of revision {n} of the {slug}")
    entry = next((e for e in history(c, inv_id, slug, doc)["versions"] if e["n"] == int(n)), None)
    hit = next((r for r in (entry or {}).get("revisions") or [] if r["i"] == int(i) and r["generation"]), None)
    if hit is None:
        raise HTTPException(404, f"no revision {i} of revision {n} of the {slug}")
    return document_of(c, inv_id, slug, int(hit["generation"]), doc)


def document_of(c: str, inv_id: str, slug: str, n: int, doc: dict[str, Any]) -> dict[str, Any]:
    """Generation `n` of the document as it stood; 404 when no record holds it."""
    current = max(_generation(doc), 1)
    if n == current:
        return doc
    if 1 <= n < current:
        rec = _records(c, inv_id, slug).get(n + 1)
        prev = rec.get("previous") if isinstance(rec, dict) else None
        if isinstance(prev, dict):
            return prev
    raise HTTPException(404, f"no stored text for revision {n} of the {slug}")
