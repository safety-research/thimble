"""The report's reader in the terminal panel (plugin/hooks/term report.ts, read-only: the report is written and edited
in the browser workbench) and the panel's Checks view: the surface and the changes they need beside local.py's, each
through the route the browser's report calls, so a comment keeps its id as it does in the browser.

  thimble state checks                      GET /checks: every report check, its name, colour, `shown` and runs, which
                                            name a comment's check and say a run goes on a document
  thimble act comment-resolve {doc, comment}   the margin's ✓ (POST …/comments/{id}/dismiss)
  thimble act comment-reopen {doc, comment}    a resolved comment opened again (POST …/comments/{id}/reopen)

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


SURFACES = {"checks": _checks}
ACTS = {"comment-resolve": _act_comment_resolve, "comment-reopen": _act_comment_reopen}
STATE_USAGE = ", checks"
ACT_USAGE = ", comment-resolve {doc, comment}, comment-reopen {doc, comment}"

