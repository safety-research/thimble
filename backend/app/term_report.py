"""The report in terminal mode (mods/thimble-term hooks/report.ts): the surface and the changes its panel needs beside
local.py's, each through the route the browser's report calls, so a comment and a passage keep their ids as they do in
the browser.

  thimble state checks                      GET /checks: every report check, its name, colour, `shown` and runs, which
                                            name a comment's check and say a run goes on a document
  thimble act comment-resolve {doc, comment}   the margin's ✓ (POST …/comments/{id}/dismiss)
  thimble act comment-reopen {doc, comment}    a resolved comment opened again (POST …/comments/{id}/reopen)
  thimble act doc-save {doc, title?, blocks}   the editor's save (PUT …/blocks): the whole document as blocks, each with
                                               the id of the unit it was built from, reconciled as the browser's editor
                                               saves it (report_types.apply_blocks)

local.py registers them. A failure is an HTTPException, which local.state and local.act turn into `{error}`."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def _slug(payload: dict[str, Any]) -> str:
    slug = str(payload.get("doc") or "").strip().removeprefix("report:")
    if not slug:
        raise HTTPException(400, "`doc` is empty")
    return slug


def _comment(payload: dict[str, Any]) -> str:
    cid = str(payload.get("comment") or "").strip()
    if not cid:
        raise HTTPException(400, "`comment` is empty")
    return cid


async def _checks(c: str, args: list[str], pos: list[str]) -> Any:
    from . import checks  # noqa: PLC0415

    return await checks.list_route(c)


async def _act_comment_resolve(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The margin's ✓ on a comment: resolved (`dismissed`), as the browser's route stores it."""
    from . import investigation, report_types  # noqa: PLC0415

    slug, cid = _slug(payload), _comment(payload)
    await report_types.dismiss(c, investigation.MAIN, slug, cid)
    return {"doc": slug, "comment": cid, "status": "dismissed"}


async def _act_comment_reopen(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A resolved comment open again, as the browser's route opens it."""
    from . import investigation, report_types  # noqa: PLC0415

    slug, cid = _slug(payload), _comment(payload)
    await report_types.reopen(c, investigation.MAIN, slug, cid)
    return {"doc": slug, "comment": cid, "status": "open"}


async def _act_doc_save(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The panel's edit of a document saved as the browser's editor saves it (report_types.blocks_route): `blocks` in
    the editor's form ({id, type, text, level, marker, cell, caption}), a kept id keeping its unit's records and comments.
    With no `title` the title stays as it is."""
    from pydantic import ValidationError  # noqa: PLC0415

    from . import investigation, report_types  # noqa: PLC0415

    slug = _slug(payload)
    blocks = payload.get("blocks")
    if not isinstance(blocks, list):
        raise HTTPException(400, "`blocks` must be a list of the editor's blocks")
    title = " ".join(str(payload.get("title") or "").split())
    if not title:
        title = str((await report_types.get_doc_route(c, investigation.MAIN, slug)).get("title") or "")
    try:
        body = report_types.BlocksBody(title=title, blocks=blocks, client="terminal")
    except ValidationError as e:
        raise HTTPException(400, f"the blocks do not read as the editor's: {e.errors()[0].get('msg')}") from None
    target = await report_types.blocks_route(c, investigation.MAIN, slug, body)
    return {"doc": slug, "title": target.get("title") or "", "sections": len(target.get("sections") or []),
            "comments": len(report_types.open_comments(target))}


SURFACES = {"checks": _checks}
ACTS = {"comment-resolve": _act_comment_resolve, "comment-reopen": _act_comment_reopen, "doc-save": _act_doc_save}
STATE_USAGE = ", checks"
ACT_USAGE = ", comment-resolve {doc, comment}, comment-reopen {doc, comment}, doc-save {doc, title?, blocks}"
