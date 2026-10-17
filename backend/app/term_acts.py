"""The terminal's changes after the press: `thimble act <kind>` (app/local.py) for an act whose state this server holds
in memory (local.SERVER_ACTS: the comments of a document and of Claude's answers, the view proposals and their builds,
the notices) posts here, POST /api/ws/{c}/act {kind, payload}. It is a token route that only thimble's command posts to
(hook_auth.CLI_WS_PATHS), as the terminal UI's every change goes through `thimble act` (plugin/hooks/term/data.ts), and
it makes the change that command makes on local transport before the press (local_hooks.ANSWERS), with the same answer:
{queued: true}, or {queued: false, reason} for an answer to a view that thimble refused. A label's run (`label-run`,
local.SERVER_RUNS) runs here as that command runs it before the press (local._act_label_run), since only this server
hands a prompt label's model calls to main's session after it; the answer comes once the run ends: the act's own, or
{ok: false, error} for a run that could not start or failed.

The browser's routes for the same changes keep refusing the token: a click there needs the browser's cookie
(subagents.analyst_only). The token proves only what thimble's hooks, plugin and command change (hook_auth module note),
and an agent's token, whose grant names its own routes, never reaches this one.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config

log = logging.getLogger("thimble.term_acts")
router = APIRouter()


def _field(payload: dict[str, Any], key: str) -> str:
    v = " ".join(str(payload.get(key) or "").split())
    if not v:
        raise HTTPException(400, f"`{key}` is empty")
    return v


def _notice_first(c: str, payload: dict[str, Any]) -> None:
    """The notice whose act the press was (`notice`), dismissed before the act runs, as local_hooks._fixing does: a
    failure the act meets again is a notice of its own."""
    from . import notices  # noqa: PLC0415

    notice_id = " ".join(str(payload.get("notice") or "").split())
    if notice_id:
        notices.dismiss(c, notice_id)


def _view_answer(fn: Any, c: str, slug: str, *args: Any) -> dict[str, Any]:
    """A view's call for the terminal's press (views.accept, answer_offer, retry) as `thimble act` answers it: {queued:
    true}; {queued: false, reason} when thimble refused the click (click_refused, whose reason the proposal keeps for
    the row above the prompt) or the view no longer takes it (404, 409)."""
    try:
        prop = fn(c, slug, *args)
    except HTTPException as e:
        return {"queued": False, "reason": str(e.detail)}
    refused = prop.get("refused") if isinstance(prop, dict) else None
    if isinstance(refused, dict) and refused.get("reason") and prop.get("status") in ("suggested", "failed", "built"):
        return {"queued": False, "reason": str(refused["reason"])}
    return {"queued": True}


async def _comment(c: str, payload: dict[str, Any], reopen: bool) -> dict[str, Any]:
    from . import report_types  # noqa: PLC0415

    doc = " ".join(str(payload.get("doc") or "").split()).removeprefix("report:")
    if not doc:
        raise HTTPException(400, "`doc` is empty")
    comment = _field(payload, "comment")
    await (report_types.reopen if reopen else report_types.dismiss)(c, "main", doc, comment)
    return {"comment": comment}


async def _answer_comment(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import checks  # noqa: PLC0415

    comment = _field(payload, "comment")
    if payload.get("reopen") is True:
        return await checks.answer_comment_reopen_route(c, comment)
    return await checks.answer_comment_dismiss_route(c, comment)


async def _view(c: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import views  # noqa: PLC0415

    views._bind_loop()
    slug = _field(payload, "slug")
    if kind == "view-accept":
        return _view_answer(views.accept, c, slug)
    if kind == "view-reject":
        return _view_answer(views.answer_offer, c, slug, "rejected")
    if kind == "view-dismiss":  # hidden, not answered: a refusal an earlier Accept left on it is no answer to this
        try:
            views.hide_offer(c, slug)
        except HTTPException as e:
            return {"queued": False, "reason": str(e.detail)}
        return {"queued": True}
    _notice_first(c, payload)
    return _view_answer(views.retry, c, slug)


async def _term_page(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A view built for the browser opened in the terminal: its terminal page's build queued (views.ensure_page), as
    local_hooks._term_page queues it, answered as local._act_view_term_page answers (views.page_ask)."""
    from . import views  # noqa: PLC0415

    views._bind_loop()
    slug = _field(payload, "slug")
    got = views.page_ask(c, slug, views.TERM_PAGE)
    if got.pop("build", False):
        views.ensure_page(c, slug, views.TERM_PAGE)
        return {"queued": True}
    return got


async def _propose_now(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """A notice's Try again: the notice dismissed first, then a check for a view proposal now (proposer.run_now), as
    local_hooks._propose_now runs it; {queued: false, reason} while view proposals are off or one waits for an answer,
    as local._act_view_propose_now answers."""
    from . import proposer, views  # noqa: PLC0415

    views._bind_loop()
    if not views.propose_enabled(c):
        return {"queued": False, "reason": 'view proposals are off; set "views": {"propose": true} in thimble\'s config'}
    if views.open_offer(c) is not None:
        return {"queued": False, "reason": "a view proposal waits for your answer above the prompt"}
    _notice_first(c, payload)
    got = proposer.run_now(c)
    if got.get("started") is False:
        return {"queued": False, "reason": str(got.get("reason") or "thimble could not check for a view proposal now")}
    return {"queued": True}


async def _notice_dismiss(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    from . import notices  # noqa: PLC0415

    return {"dismissed": notices.dismiss(c, _field(payload, "id")), "queued": True}


async def _label_run(c: str, payload: dict[str, Any]) -> dict[str, Any]:
    """`thimble act label-run` after the press (module note): the run as that command makes it before the press, here,
    where main's session's module takes its model calls (bug hunt E8); its refusal or failure as {ok: false, error}."""
    from . import local  # noqa: PLC0415

    try:
        return await local._act_label_run(c, payload)
    except local.StateError as e:
        return {"ok": False, "error": str(e)}
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}


class ActBody(BaseModel):
    kind: str
    payload: dict[str, Any] = {}


@router.post("/ws/{c}/act")
async def act_route(c: str, body: ActBody) -> dict[str, Any]:
    """`thimble act <kind>` after the press (module note); 400 for a kind this route does not take."""
    config.workspace_dir(c)
    kind, payload = body.kind, body.payload
    if kind in ("comment-resolve", "comment-reopen"):
        return await _comment(c, payload, kind == "comment-reopen")
    if kind == "answer-comment-resolve":
        return await _answer_comment(c, payload)
    if kind in ("view-accept", "view-reject", "view-dismiss", "view-retry"):
        return await _view(c, kind, payload)
    if kind == "view-term-page":
        return await _term_page(c, payload)
    if kind == "view-propose-now":
        return await _propose_now(c, payload)
    if kind == "notice-dismiss":
        return await _notice_dismiss(c, payload)
    if kind == "label-run":
        return await _label_run(c, payload)
    raise HTTPException(400, f"this route takes no act {kind!r}")
