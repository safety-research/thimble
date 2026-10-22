"""The problem report's routes, kept apart from feedback.py so that module imports only the standard library and
`thimble feedback` runs with the server down.

POST /api/ws/{c}/feedback builds the zip (feedback.build) from the browser's Report a problem dialog. POST
/api/feedback/reveal shows a bundle in the file manager, and GET /api/feedback/download?path= sends it to the browser.
All three answer loopback callers only, and the last two only for a bundle feedback.py wrote.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, feedback

router = APIRouter()
MAX_FOCUS = 20  # chats a report may name first


class ReportBody(BaseModel):
    description: str = ""
    screenshot: str | None = None  # a data URL of a PNG or JPEG
    screenshot_asked: bool = False  # the reporter asked for one, so its absence is said
    logs: bool = True
    user_agent: str = ""
    browser: list[Any] = Field(default_factory=list)  # the ring buffer; feedback.browser_rows keeps its objects
    focus: list[str] = Field(default_factory=list)


class RevealBody(BaseModel):
    path: str


def _loopback_or_403(request: Request) -> None:
    from . import dev  # noqa: PLC0415 — dev is heavy and only these routes need its loopback rule

    if not dev._is_loopback(request):
        raise HTTPException(403, "a problem report is made from this machine only")


@router.post("/ws/{c}/feedback", status_code=201)
async def post_report(c: str, body: ReportBody, request: Request) -> dict[str, Any]:
    _loopback_or_403(request)
    try:
        ws: tuple[str, Path] | None = (c, config.workspace_path(c))
    except (ValueError, HTTPException):
        ws = None
    try:
        return await asyncio.to_thread(feedback.build, body.description, workspace=ws, screenshot=body.screenshot,
                                       logs=body.logs, user_agent=body.user_agent, browser=body.browser,
                                       focus=body.focus[:MAX_FOCUS], shot_asked=body.screenshot_asked)
    except OSError as e:
        raise HTTPException(507, str(e)) from e


@router.post("/feedback/reveal")
async def post_reveal(body: RevealBody, request: Request) -> dict[str, Any]:
    _loopback_or_403(request)
    try:
        feedback.reveal(body.path)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except LookupError as e:
        raise HTTPException(409, str(e)) from e
    return {"ok": True}


@router.get("/feedback/download")
async def get_download(path: str, request: Request) -> FileResponse:
    _loopback_or_403(request)
    try:
        p = feedback.own_bundle(path)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return FileResponse(p, media_type="application/zip", filename=p.name)
