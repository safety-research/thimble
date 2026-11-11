"""A document published as a Claude artifact: Export, Claude artifact, in the report's Export menu.

Only Claude Code publishes an artifact, with its Artifact tool (TOOL), which a session has when Claude Code is signed in
to claude.ai and artifacts are allowed there. So the server writes the document's artifact page (exports.artifact_page)
into the workspace's exports folder (DIR), and main publishes it (publish):
- with an API key or WIF (runtime.engine "api"), nothing is published: the notice (KEY) says why, and that Settings,
  Claude access, can choose the Claude Code sign-in; the page downloads the artifact page instead (GET …/export/artifact);
- with the Claude Code sign-in, the analyst's line goes into main's chat and main gets the request (prompts/tools.md
  `export-artifact`), which waits for main's running turn to end, as a /thimble-fix does. Main's session has the
  Artifact tool in the turns an export waits for (runtime.spec_of), not in others, since its text asks Claude to
  publish finished work by itself. A session kept open for a command main runs in the background goes on without it,
  so the command is not stopped: an export then publishes nothing and says why.

In that turn main may publish that page and nothing else: runtime_cc's hook refuses every other call of the Artifact
tool (may_publish), and its permission callback allows the publish when Claude Code asks. runtime_cc hands each
result of main's Artifact calls here (result): a link ends the export (an `export` record on the workspace stream,
whose link the page shows), and an error is kept as the reason. When main's turn on the request ends without a link
(turn_ended), the export failed: the notice says why (the session had no Artifact tool, the tool's error, main's last
words, or the turn stopped or failed) with the fix, and the `export` record has the page download the artifact page.

A document's page is always the same file, so an export again in the same chat of main updates the artifact it
published, as the Artifact tool publishes a file it published before in the conversation to the same link.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from . import config, nofollow

log = logging.getLogger("thimble.artifact_export")
router = APIRouter()

DIR = "exports"  # in the workspace, out of reach of a card's code and of main's commands: <doc>.html, the page to publish
TOOL = "Artifact"  # Claude Code's tool that publishes a page as a private claude.ai artifact and gives its link
KEY = "export-artifact"  # the notice's key (notices.py), cleared by a later publish
RECORD = "export"  # the type of the record on the workspace stream that ends an export (frontend lib/events.ts)
# a claude.ai artifact's link, as the Artifact tool gives it (the terminal reads a card's the same way, cards/head.ts)
LINK_RE = re.compile(r"https://claude\.ai/(?:code/)?artifact/[\w-]+")
REASON_CHARS = 280  # of the tool's error or main's words, inside the notice
LINE = "Export the {doc} as a Claude artifact"  # the analyst's line in main's chat
NOT_PUBLISHED = "The {doc} was not published as a Claude artifact: {why}. Its page downloaded instead. {fix}"
API_WHY = "only a Claude Code sign-in can publish one, and thimble reaches Claude with {how}"
API_HOW = {"api-key": "an Anthropic API key", "wif": "Workload Identity Federation"}  # claude_access's choices
NO_WAY = "thimble has no way to reach Claude yet"
API_FIX = "To publish from thimble, choose your Claude Code sign-in in Settings, Claude access."
NO_TOOL_WHY = ("Claude Code offered no Artifact tool, which it has only when it is signed in to claude.ai and artifacts "
               "are allowed there")
NO_TOOL_FIX = "In your terminal: run `claude`, sign in to claude.ai with /login, then export again."
HELD_WHY = "main's session runs a command in the background, and that session has no Artifact tool"
HELD_FIX = "Export again once the command ends."
TOOL_WHY = "Claude Code's Artifact tool answered: {error}"
SAID_WHY = "main did not publish it, and said: {said}"
STOPPED_WHY = "main's turn stopped before it published"
FAILED_WHY = "main's turn failed: {error}"
AGAIN_FIX = "Export again to try once more."


@dataclass
class Waiting:
    """An export that waits for main: its document, the page's file, the event main reads it in, and the Artifact
    tool's last error in that turn."""
    doc: str
    page: Path
    event: str
    error: str = ""


_waiting: dict[str, dict[str, Waiting]] = {}  # workspace -> by event id, its exports that wait for main


def page_path(c: str, slug: str) -> Path:
    """The file of document `slug`'s artifact page, the same at each export."""
    return config.workspace_dir(c) / DIR / f"{slug}.html"


def waiting(c: str) -> bool:
    """Whether an export waits for main in workspace `c`, so main's turn gets the Artifact tool (runtime.spec_of)."""
    return bool(_waiting.get(c))


def _short(text: Any) -> str:
    t = " ".join(str(text or "").split()).rstrip(".")
    return t if len(t) <= REASON_CHARS else t[: REASON_CHARS - 1].rsplit(" ", 1)[0] + "…"


def _text(content: Any) -> str:
    """A tool result's words: its text, or the text of each of its blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(b.get("text") or "") for b in content if isinstance(b, dict))
    return str(content or "")


def _record(c: str, doc: str, status: str, **fields: Any) -> None:
    """The `export` record on the workspace stream, from the server's loop (a call off it, as a server's stop is, tells
    nothing; the notice still does)."""
    from . import investigation  # noqa: PLC0415

    try:
        asyncio.get_running_loop()
        investigation.emit(c, investigation.MAIN, {"type": RECORD, "format": "artifact", "doc": doc, "status": status,
                                                   **fields})
    except Exception:  # noqa: BLE001 — the notice and main's chat still tell
        log.debug("%s: the export record of %s was not emitted", c, doc, exc_info=True)


def _tell(c: str, doc: str, why: str, fix: str, action: Any = None) -> None:
    """The notice that the export of `doc` published nothing, with why and the fix."""
    from . import notices  # noqa: PLC0415

    notices.post(c, kind="export", key=KEY, text=NOT_PUBLISHED.format(doc=doc, why=why, fix=fix), action=action)


def _api_why() -> str:
    from . import claude_access  # noqa: PLC0415

    how = API_HOW.get(claude_access.how())
    return API_WHY.format(how=how) if how else NO_WAY


async def publish(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    """Export, Claude artifact, on document `slug` (module note): {publishing: true} once main has the request, else
    {publishing: false} with the notice told, and the page downloads the artifact page. The HTTPExceptions of
    exports.read_for, and events.post's."""
    from fastapi import HTTPException  # noqa: PLC0415

    from . import agents, events, exports, notices, runtime, tools  # noqa: PLC0415

    m = await exports.read_for(c, inv_id, slug, "artifact")
    if runtime.engine() != "cc":
        _tell(c, slug, _api_why(), API_FIX, notices.SETTINGS)
        return {"publishing": False}
    if runtime.ensure(c).main.cc is not None:  # main's session is kept open for a command in the background
        _tell(c, slug, HELD_WHY, HELD_FIX)
        return {"publishing": False}
    page = page_path(c, slug)
    text = await exports.artifact_page(c, m)
    await asyncio.to_thread(nofollow.write_text, page, text, make=True)
    eid = secrets.token_hex(4)
    _waiting.setdefault(c, {})[eid] = Waiting(slug, page, eid)
    said = LINE.format(doc=slug)
    agents.mirror(c, "user", by=agents.BROWSER, text=said, event=eid)
    try:
        events.post(c, events.MAIN, {"text": tools.hint("export-artifact", doc=slug, title=m["title"], page=str(page))},
                    mirror=False, line=said, event_id=eid)
    except HTTPException:
        _waiting.get(c, {}).pop(eid, None)
        raise
    return {"publishing": True}


def _waiting_for(c: str, inp: Any) -> Waiting | None:
    """The export whose page a call of the Artifact tool with input `inp` names as its file, if one waits."""
    name = str((inp or {}).get("file_path") or "") if isinstance(inp, dict) else ""
    if not name:
        return None
    try:
        path = Path(name).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    return next((w for w in _waiting.get(c, {}).values() if w.page.resolve() == path), None)


def may_publish(c: str, inp: Any) -> bool:
    """Whether a call of main's Artifact tool with input `inp` publishes the page of an export that waits, and nothing
    else: the publish action (the tool's default), with that page as its file and no other files (runtime_cc)."""
    if not isinstance(inp, dict) or inp.get("action") not in (None, "", "publish"):
        return False
    if any(inp.get(k) for k in ("files", "root", "type_url")):
        return False
    return _waiting_for(c, inp) is not None


def result(c: str, inp: Any, content: Any, is_error: bool) -> None:
    """A result of main's Artifact tool (runtime_cc). For the page of an export that waits, a link publishes it: the
    notice goes, and the record gives the page the link. An error, or a result with no link, is kept as the reason
    should the turn end without one."""
    from . import notices  # noqa: PLC0415

    w = _waiting_for(c, inp)
    if w is None:
        return
    said = _text(content)
    link = None if is_error else LINK_RE.search(said)
    if link is None:
        w.error = _short(said) or "it gave no link"
        return
    _waiting.get(c, {}).pop(w.event, None)
    notices.clear(c, KEY)
    _record(c, w.doc, "published", link=link.group(0))


def turn_ended(c: str, event: str, end: Any) -> None:
    """Main's turn on the request `event` ended (runtime._main_loop), or its request went unread as main's chat changed
    (runtime.Space.switch): `end` is the turn's TurnEnd, None when it stopped or never ran. An export it did not publish
    failed (module note)."""
    from . import notices, runtime  # noqa: PLC0415

    w = _waiting.get(c, {}).pop(event, None)
    if w is None:
        return
    main = runtime.ensure(c).main if end is not None else None
    if main is None:
        _tell(c, w.doc, STOPPED_WHY, AGAIN_FIX)
    elif runtime.engine() != "cc":
        _tell(c, w.doc, _api_why(), API_FIX, notices.SETTINGS)
    elif w.error:
        _tell(c, w.doc, TOOL_WHY.format(error=w.error), AGAIN_FIX)
    elif TOOL not in (main.tools or ()):
        # the turn ran in the session kept open for a command in the background (runtime.spec_of), or Claude Code has
        # no Artifact tool with this sign-in
        _tell(c, w.doc, *((HELD_WHY, HELD_FIX) if main.cc is not None else (NO_TOOL_WHY, NO_TOOL_FIX)))
    elif end.status == "failed":
        _tell(c, w.doc, FAILED_WHY.format(error=_short(end.error) or "no reason given"), AGAIN_FIX)
    else:
        _tell(c, w.doc, SAID_WHY.format(said=_short(end.text) or "nothing"), AGAIN_FIX)
    _record(c, w.doc, "failed")


def forget(c: str) -> None:
    """The workspace's folder goes, or the server stops (runtime.forget, stop_all): its exports that wait end with no
    notice, which nobody would read where it is kept."""
    _waiting.pop(c, None)


# --------------------------------------------------------------------------- route


@router.post("/ws/{c}/investigations/{inv_id}/types/{slug}/export/artifact")
async def publish_route(c: str, inv_id: str, slug: str) -> dict[str, Any]:
    from .exports import _slug  # noqa: PLC0415

    return await publish(c, inv_id, _slug(c, inv_id, slug))
