"""Comments and checks from the chat: main's own note beside a passage of a written document or beside a card or a plan
step (`add_comment` from main's shim), a comment resolved or opened again (`resolve_comment`), and a check turned off
(`stop_check`), the chat counterparts of the margin's Comment, ✓ and Know it and the Comments pane's switch.

A note on a card goes to the cards' comments (canvas_comments.add) with author `claude`; `resolve_comment` takes such a
comment's id, or `card:<id>` (`#step-<n>`) for every open comment there, and `how: known` for Know it.

Main's note is stored as the analyst's comments are, `{id, sentence_id, text, details, author: "claude", ts, status:
open}`, with no check and no run, so no run supersedes it. A note on a paragraph goes on its first sentence marked
`paragraph`. Its statement `text` has its citations flattened to their values for reading, its `details` keep theirs,
and both cite into `evidence` (checks.note_parts). `resolve_comment` takes a comment's id
or a passage's ref (every open comment on it); both it and `reopen` leave the comment in the document. `stop_check`
sets the check's `shown` false and stops its runs; its comments stay stored. Each change emits
`report {status: commented}` for the document it changed.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from . import investigation, tools

AUTHOR = "claude"  # the author of a note of main's
OFF = "off"  # the status of the `check` record stop_check emits, which names no document
RESOLVED_BY = "resolved_by"  # who resolved a comment through resolve_comment, cleared when it is opened again
_BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _clean_ref(v: Any) -> str:
    return str(v or "").strip().strip("[]").strip()


def _emit(c: str, slug: str, span: str) -> None:
    from . import report_types  # noqa: PLC0415 — report_types imports checks, which imports this module lazily

    report_types._emit(c, {"type": "report", "slug": slug, "status": "commented", "span": span})


# --------------------------------------------------------------------------- add_comment from main


async def tool_add_comment(ctx: Any, args: dict[str, Any]) -> Any:
    """`add_comment` from main's shim: a note of main's beside the passage `ref` names, under the documents' lock from
    the document's read to its write (report_types.docs_lock)."""
    from . import report_types  # noqa: PLC0415

    with report_types.docs_lock(ctx.c):
        return _add_comment(ctx, args)


def _add_card_note(ctx: Any, ref: str, text: str, details: Any) -> Any:
    """Main's note beside a card or a plan step of any group (canvas_comments.add, author claude)."""
    from . import canvas_comments, checks, notebook  # noqa: PLC0415

    hit = canvas_comments.parse_ref(ref)
    cell = notebook.get_cell(ctx.c, hit[0]) if hit else None
    steps = canvas_comments.steps_of(cell) if cell else []
    step = next((s for s in steps if s["n"] == hit[1]), None) if hit and hit[1] is not None else None
    if hit is None or cell is None or (hit[1] is not None and step is None):
        return tools.err(tools.hint("add_comment-no-card", ref=ref))
    shown, more, evidence = checks.note_parts(ctx.c, text, details)
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    cm, _ = canvas_comments.add(ctx.c, card=hit[0], step=step["id"] if step else None, text=shown, details=more,
                                author=AUTHOR, evidence=evidence)
    return tools.ok(f"commented on {canvas_comments.step_ref(*hit)}, comment {cm['id']}")


def _add_comment(ctx: Any, args: dict[str, Any]) -> Any:
    from . import canvas_comments, checks, report, report_types  # noqa: PLC0415

    ref = _clean_ref(args.get("ref"))
    text = _collapse(args.get("text"))
    if not text:
        return tools.err("add_comment: `text` is empty")
    if canvas_comments.parse_ref(ref) is not None:
        return _add_card_note(ctx, ref, text, args.get("details"))
    m = checks._REF_RE.match(ref)
    slug = m.group(1) if m else ""
    doc = report_types.read_doc(ctx.c, investigation.MAIN, slug) if slug else None
    if m is None or doc is None:
        return tools.err(tools.hint("add_comment-no-document", ref=ref or "(no ref)",
                                    docs=", ".join(f"report:{d}" for d in checks._written(ctx.c)) or "none"))
    p = checks.passage_of(slug, doc, ref)
    if p is None:
        return tools.err(tools.hint("add_comment-no-passage", ref=ref, doc=slug))
    whole = bool(m.group(2))  # a note on a paragraph (`#p<id>`), which goes on its first sentence
    uid = p["anchor"] if whole else m.group(3)
    used = report_types._ids(doc)
    shown, details, evidence = checks.note_parts(ctx.c, text, args.get("details"), doc_ids=used)
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    comments = doc.setdefault("comments", [])
    same = next((cm for cm in comments if isinstance(cm, dict) and cm.get("author") == AUTHOR and not cm.get("check")
                 and (cm.get("status") or "open") == "open" and str(cm.get("sentence_id")) == uid
                 and bool(cm.get("paragraph")) == whole and _collapse(cm.get("text")) == shown
                 and canvas_comments.clean_details(cm.get("details")) == details), None)
    if same is None:
        same = {"id": report._new_id(used), "sentence_id": uid, **({"paragraph": True} if whole else {}), "text": shown,
                "details": details, "author": AUTHOR, "evidence": evidence, "ts": _now(), "status": "open",
                "generation": int(doc.get("generation") or 1)}
        comments.append(same)
        report_types.write_doc(ctx.c, investigation.MAIN, slug, doc)
        _emit(ctx.c, slug, f"report:{slug}#{uid}")
    # the result names the passage as the call did, so a note on a paragraph reads as the paragraph's
    return tools.ok(tools.hint("add_comment-added", doc=slug, sid=f"p{m.group(3)}" if whole else uid, comment=same["id"]))


# --------------------------------------------------------------------------- resolve_comment


def _who(c: str, cm: dict[str, Any]) -> str:
    from . import checks  # noqa: PLC0415

    if cm.get("check"):
        return checks.names(c).get(str(cm["check"]), str(cm["check"]))
    return str(cm.get("author") or "analyst")


def _targets(c: str, value: str, want_open: bool) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None]:
    """(the document's slug, the comments `value` names in the state `want_open` asks for, the document) for a
    comment's id, `report:<doc>#<comment id>`, or `report:<doc>#<passage id>` (every comment on that passage)."""
    from . import checks, report_types  # noqa: PLC0415

    def state_ok(cm: Any) -> bool:
        return isinstance(cm, dict) and ((cm.get("status") or "open") == "open") == want_open

    m = checks._REF_RE.match(value)
    slugs = [m.group(1)] if m else checks._written(c)
    cid = (f"p{m.group(3)}" if m.group(2) else m.group(3)) if m else value
    for slug in slugs:
        doc = report_types.read_doc(c, investigation.MAIN, slug)
        if doc is None:
            continue
        one = [cm for cm in doc.get("comments") or [] if state_ok(cm) and str(cm.get("id")) == cid]
        if one:
            return slug, one, doc
        if m is not None:
            p = checks.passage_of(slug, doc, value)
            ids = set(p["ids"]) if p else set()
            return slug, [cm for cm in doc.get("comments") or [] if state_ok(cm) and str(cm.get("sentence_id")) in ids], doc
    return "", [], None


async def tool_resolve_comment(ctx: Any, args: dict[str, Any]) -> Any:
    """The `resolve_comment` tool, under the documents' lock (report_types.docs_lock)."""
    from . import report_types  # noqa: PLC0415

    with report_types.docs_lock(ctx.c):
        return _resolve_comment(ctx, args)


def _resolve_card_comments(ctx: Any, value: str, reopen: bool, how: str) -> Any | None:
    """resolve_comment on the cards' comments: a comment's id, or a card's or a step's ref for every comment there in
    the state asked; None when `value` names none of them."""
    from . import canvas_comments  # noqa: PLC0415

    hit = canvas_comments.parse_ref(value)
    pool = [cm for cm in canvas_comments.all_comments(ctx.c) if ((cm.get("status") or "open") == "open") != reopen]
    if hit is not None:
        found = [cm for cm in pool if cm["card"] == hit[0] and (hit[1] is None or cm.get("n") == hit[1])]
    else:
        found = [cm for cm in pool if str(cm["id"]) == value]
    if not found:
        return None
    ids = [str(cm["id"]) for cm in found]
    if reopen:
        canvas_comments.reopen(ctx.c, ids)
    else:
        canvas_comments.resolve(ctx.c, ids, how, by=AUTHOR)
    return tools.ok("\n".join(tools.hint("resolve_comment-done", action="reopened" if reopen else "resolved",
                                         comment=cm["id"], ref=cm["ref"], who=canvas_comments._who(ctx.c, cm),
                                         text=_collapse(cm.get("text"))) for cm in found))


def _resolve_comment(ctx: Any, args: dict[str, Any]) -> Any:
    from . import canvas_comments, report, report_types  # noqa: PLC0415

    value = _clean_ref(args.get("comment"))
    reopen = args.get("reopen") is True
    how = _collapse(args.get("how")).lower() or "done"
    if how not in canvas_comments.HOWS:
        return tools.err(f"resolve_comment: `how` is one of {', '.join(canvas_comments.HOWS)}")
    is_card = canvas_comments.parse_ref(value) is not None
    if not value or not (value.startswith("report:") or is_card or _BARE_ID_RE.match(value)):
        return tools.err(tools.hint("resolve_comment-none", comment=value or "(no comment)",
                                    state="resolved" if reopen else "open"))
    slug, found, doc = _targets(ctx.c, value, want_open=not reopen) if not is_card else ("", [], None)
    if not found or doc is None:
        on_cards = None if value.startswith("report:") else _resolve_card_comments(ctx, value, reopen, how)
        if on_cards is not None:
            return on_cards
        return tools.err(tools.hint("resolve_comment-none", comment=value, state="resolved" if reopen else "open"))
    from . import checks  # noqa: PLC0415

    ps = checks.passages(slug, doc)
    lines = []
    for cm in found:
        sid = str(cm.get("sentence_id"))
        # a comment on a whole paragraph is named by the paragraph's ref, as add_comment took it
        where = (checks._of_comment(slug, ps, sid) if cm.get("paragraph") else None) or f"report:{slug}#{sid}"
        if reopen:
            report.reopen_comment(cm)
            cm.pop(RESOLVED_BY, None)
        else:
            cm["status"] = report.SETTLED_STATUS
            cm[RESOLVED_BY] = AUTHOR
            cm["resolution"] = how
            cm["resolved_ts"] = _now()
        lines.append(tools.hint("resolve_comment-done", action="reopened" if reopen else "resolved", comment=cm.get("id"),
                                ref=where, who=_who(ctx.c, cm), text=_collapse(cm.get("text"))))
    report_types.write_doc(ctx.c, investigation.MAIN, slug, doc)
    _emit(ctx.c, slug, f"report:{slug}#{found[0].get('sentence_id')}")
    return tools.ok("\n".join(lines))


# --------------------------------------------------------------------------- stop_check


async def tool_stop_check(ctx: Any, args: dict[str, Any]) -> Any:
    """The `stop_check` tool."""
    from . import checks  # noqa: PLC0415

    name = _collapse(args.get("name"))
    check = checks.by_name(ctx.c, name) if name else None
    if check is None:
        return tools.err(tools.hint("stop_check-none", check=name or "(no name)",
                                    names=", ".join(x["name"] for x in checks.list_checks(ctx.c))))
    docs = sorted(doc for (c, cid, doc) in list(checks._active) if c == ctx.c and cid == check["id"])
    checks.edit(ctx.c, check["id"], shown=False)
    await checks.stop_check(ctx.c, check["id"])
    for key in [k for k in checks._dirty if k[0] == ctx.c and k[1] == check["id"]]:
        checks._dirty.discard(key)  # a run stopped here is not followed by the rerun a save during it asked for
    checks._stream(ctx.c, check["id"], "", OFF, "", "")  # no document: the open tabs read the checks again
    if not docs:
        return tools.ok(tools.hint("stop_check-off", check=check["name"]))
    return tools.ok(tools.hint("stop_check-stopped", check=check["name"], docs=", ".join(checks.target_name(d) for d in docs)))


# --------------------------------------------------------------------------- the comment a thread is about


STATEMENT_CHARS = 300  # of a comment's statement, kept on the thread Ask opens on it


def thread_comment(c: str, cid: str | None) -> dict[str, Any] | None:
    """{id, check, name, colour, text} of the comment `cid`, on the cards or in a written document, which the thread
    that Ask opens on it keeps (agents.new_thread, `anchor_comment`) so its anchor line names the comment: its check's id,
    name and color (the analyst's own comment is `You`, main's `Claude`, with no check) and its statement. None for no
    such comment."""
    from . import canvas_comments, checks, report_types  # noqa: PLC0415

    want = _clean_ref(cid)
    if not want or not _BARE_ID_RE.match(want):
        return None
    found = next((cm for cm in canvas_comments.all_comments(c) if str(cm.get("id")) == want), None)
    if found is None:
        for slug in checks._written(c):
            doc = report_types.read_doc(c, investigation.MAIN, slug) or {}
            found = next((cm for cm in doc.get("comments") or [] if isinstance(cm, dict) and str(cm.get("id")) == want),
                         None)
            if found is not None:
                break
    if found is None:
        return None
    check = str(found.get("check") or "") or None
    record = next((x for x in checks.list_checks(c) if x["id"] == check), None) if check else None
    if check:
        name = str((record or {}).get("name") or check)
    else:
        name = "Claude" if str(found.get("author") or "") == AUTHOR else "You"
    text = _collapse(canvas_comments.note_of(found)["text"])
    if len(text) > STATEMENT_CHARS:
        text = text[: STATEMENT_CHARS - 1].rstrip() + "…"
    colour = (record or {}).get("colour")
    return {"id": want, "check": check, "name": name, "colour": colour if isinstance(colour, int) else None, "text": text}
