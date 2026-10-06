"""Comments and checks from the chat: main's own note beside a passage of a written document (`add_comment` from main's
shim), a comment resolved or opened again (`resolve_comment`), and a report check turned off (`stop_check`), the chat
counterparts of the margin's Comment and ✓ and the Checks pane's switch.

Main's note is stored as the analyst's comments are, `{id, sentence_id, text, author: "claude", ts, status: open}`,
with no check and no run, so no run supersedes it. A note on a paragraph goes on its first sentence marked `paragraph`.
Its citations are flattened to their values for reading and kept as `evidence`. `resolve_comment` takes a comment's id
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


def _add_comment(ctx: Any, args: dict[str, Any]) -> Any:
    from . import checks, refs, report, report_types  # noqa: PLC0415

    ref = _clean_ref(args.get("ref"))
    text = _collapse(args.get("text"))
    if not text:
        return tools.err("add_comment: `text` is empty")
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
    cited = list(dict.fromkeys(refs.extract_refs(text)))
    shown = report_types.readable_ids(report.plain_text(text), cells=report_types.workspace_cell_ids(ctx.c), doc_ids=used)
    if not shown:
        return tools.err("add_comment: `text` holds nothing but citations")
    comments = doc.setdefault("comments", [])
    same = next((cm for cm in comments if isinstance(cm, dict) and cm.get("author") == AUTHOR and not cm.get("check")
                 and (cm.get("status") or "open") == "open" and str(cm.get("sentence_id")) == uid
                 and bool(cm.get("paragraph")) == whole and _collapse(cm.get("text")) == shown), None)
    if same is None:
        same = {"id": report._new_id(used), "sentence_id": uid, **({"paragraph": True} if whole else {}), "text": shown,
                "author": AUTHOR, "evidence": " ".join(cited), "ts": _now(), "status": "open",
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


def _resolve_comment(ctx: Any, args: dict[str, Any]) -> Any:
    from . import report, report_types  # noqa: PLC0415

    value = _clean_ref(args.get("comment"))
    reopen = args.get("reopen") is True
    if not value or not (value.startswith("report:") or _BARE_ID_RE.match(value)):
        return tools.err(tools.hint("resolve_comment-none", comment=value or "(no comment)",
                                    state="resolved" if reopen else "open"))
    slug, found, doc = _targets(ctx.c, value, want_open=not reopen)
    if not found or doc is None:
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
    return tools.ok(tools.hint("stop_check-stopped", check=check["name"], docs=", ".join(f"report:{d}" for d in docs)))
