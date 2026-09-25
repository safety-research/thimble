"""What changed since a document's generation was written, for the writer agent that revises it
(report_types.document_text
appends it to read_ref of the document). The anchor is the document's `snapshot` of cell fingerprints and comments;
changes_since lists cards added, changed or deleted and the analyst's text edits. No model runs here."""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from . import cite, material, notebook

log = logging.getLogger("thimble.revise_diff")

ANALYST = "analyst"
EDIT_AUTHORS = ("analyst", "rewrite")
FINGERPRINT_PARTS = ("code", "takeaway", "outputs", "status")


def typed_instruction(request: str | None) -> str | None:
    """The analyst's instruction for a generation, stripped, or None when nothing was typed."""
    text = str(request or "").strip()
    return text or None


def earlier_instruction(prev: dict[str, Any] | None) -> str | None:
    """The line naming the instruction the previous generation was written under, or None."""
    text = str((prev or {}).get("instructions") or "").strip()
    if not text:
        return None
    gen = (prev or {}).get("generation") or 1
    return f"The analyst's instruction for generation {gen}, followed when it was written: {material.collapse(text)}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha(*parts: Any) -> str:
    return hashlib.sha1(json.dumps(list(parts), ensure_ascii=False, default=str).encode("utf-8")).hexdigest()[:16]


def fingerprint(x: dict[str, Any]) -> dict[str, Any]:
    """One cell's fingerprint, the whole and the parts that can change on their own."""
    body = x.get("code") if x["kind"] == "code" else x.get("text")
    return {"h": _sha(x["kind"], body, x.get("title"), x.get("takeaway"), x.get("exec_count"), x.get("status"), len(x.get("outputs_text") or "")),
            "code": _sha(x["kind"], body, x.get("title")), "takeaway": _sha(x.get("takeaway")),
            "outputs": len(x.get("outputs_text") or ""), "status": str(x.get("status") or "")}


def _all_cells(c: str) -> list[dict[str, Any]]:
    return material.notebook_cells(c, tuple(notebook.ROLES), raw=True)


def snapshot(c: str, inv_id: str, doc: dict[str, Any]) -> dict[str, Any]:
    """The workspace as it stands when `doc` is stored. Never raises."""
    snap: dict[str, Any] = {"ts": _now(), "cells": {}, "comments": {}}
    try:
        snap["cells"] = {x["id"]: fingerprint(x) for x in _all_cells(c)}
    except Exception:  # noqa: BLE001
        log.exception("%s: the snapshot could not read the notebooks", c)
    snap["comments"] = {str(cm.get("id")): 0 for cm in doc.get("comments") or [] if isinstance(cm, dict)}
    return snap


# --------------------------------------------------------------------------- the blocks


def _after(ts: Any, since: str) -> bool:
    t = str(ts or "")
    return bool(t) and (not since or t >= since)


def _cell_line(x: dict[str, Any], what: str) -> str:
    label = x.get("notebook_role") or notebook.DEFAULT_ROLE
    head = f"- {what} card:{x['id']} ({x.get('notebook_title') or label}) {material.cut(x.get('title'), 120) or '(untitled)'}"
    # a takeaway's `cell:` refs are written `card:` before the cut, which could leave a prefix with no id after it
    tk = material.cut(cite.canon_text(str(x.get("takeaway") or "")), 200)
    return head + (f" · takeaway {tk}" if tk else " · no takeaway")


def _cell_changes(c: str, snap: dict[str, Any] | None, since: str) -> list[str]:
    cells = _all_cells(c)
    lines: list[str] = []
    if snap is not None:
        before = snap.get("cells") if isinstance(snap.get("cells"), dict) else {}
        seen: set[str] = set()
        for x in cells:
            seen.add(x["id"])
            now = fingerprint(x)
            prev = before.get(x["id"])
            if prev is None:
                lines.append(_cell_line(x, "added"))
            elif isinstance(prev, dict) and prev.get("h") != now["h"]:
                changed = [k for k in FINGERPRINT_PARTS if prev.get(k) != now[k]] or ["contents"]
                lines.append(_cell_line(x, f"changed ({', '.join(changed)})"))
        gone = [cid for cid in before if cid not in seen]
        if gone:
            lines.append("- deleted " + ", ".join(f"card:{cid}" for cid in gone))
    else:
        for x in cells:
            stamps = [x.get("created_ts"), x.get("ts")] + [e.get("ts") for e in (x.get("edited") or []) if isinstance(e, dict)]
            if any(_after(t, since) for t in stamps):
                lines.append(_cell_line(x, "added or changed"))
    return lines


def _history_lines(label: str, node: dict[str, Any], key: str, history_key: str, since: str) -> list[str]:
    entries = [h for h in (node.get(history_key) or []) if isinstance(h, dict)]
    lines: list[str] = []
    for i, h in enumerate(entries):
        if h.get("by") not in EDIT_AUTHORS or not _after(h.get("ts"), since):
            continue
        after = entries[i + 1].get("text") if i + 1 < len(entries) else node.get(key)
        by = "rewritten" if h.get("by") == "rewrite" else "edited by the analyst" if h.get("by") == ANALYST else "edited"
        lines.append(f"- {label} {by} ({h.get('ts')})\n    was {material.collapse(h.get('text'))}\n    now {material.collapse(after)}")
    return lines


def _edit_lines(prev: dict[str, Any], since: str) -> list[str]:
    from . import report_types  # noqa: PLC0415

    lines = _history_lines("the title", prev, "title", "title_history", since)
    for u in report_types.units(prev):
        lines += _history_lines(f'the heading #{u.get("id")}', u, "heading", "history", since)
        for x in report_types.unit_sentences(u):
            lines += _history_lines(f'the sentence #{x.get("id")}', x, "text", "history", since)
    return lines


def changes_since(c: str, inv_id: str, prev: dict[str, Any]) -> str:
    """What changed in the workspace and in the text since `prev` was written, as labelled lines; "" when nothing did."""
    snap = prev.get("snapshot") if isinstance(prev.get("snapshot"), dict) else None
    since = str(snap.get("ts") or "") if snap else str(prev.get("generated_at") or "")
    blocks: list[str] = []
    earlier = earlier_instruction(prev)
    if earlier:
        blocks.append(earlier)

    def safe(fn, *args) -> list[str]:
        try:
            return fn(*args)
        except Exception:  # noqa: BLE001
            log.exception("%s: what changed could not be read in one part (%s)", c, getattr(fn, "__name__", fn))
            return []

    for label, lines in (("cards", safe(_cell_changes, c, snap, since)), ("the analyst's edits of the text", safe(_edit_lines, prev, since))):
        if lines:
            blocks.append(label + "\n" + "\n".join(lines))
    return "\n".join(blocks)


__all__ = ["snapshot", "changes_since", "fingerprint", "typed_instruction", "earlier_instruction"]
