"""Comments: a note beside a card on the canvas, or beside a sentence or a heading of the report, which the analyst
writes and resolves (Done), and opens again. A model's comment (a check's, or Claude's) is kept in the same stores in
the same shape, with its `author`, `check` and `run`, so the page shows every comment alike.

The stores are thimble 0.8's shapes, each changed under one lock:

- the cards: `canvas-comments.json` in the workspace = {comments: [{id, card, step, check, run, author, text, details,
  evidence, fp, ts, status, resolution}]}. thimble browser has no plan steps, so `step` is None.
- the report: `docs/report.comments.json` = {comments: [{id, sentence_id, paragraph, text, author, ts, status,
  resolution, check, run, details, evidence, quote}]}. The report is Markdown and its passages' ids are their places
  (report.parse), so a comment also keeps `quote`, the words of its passage when it was made: when the passage at
  `sentence_id` no longer has those words, the comment moves to the passage that has them (or the one most like them),
  and a comment whose passage is gone is not served.

`status` is `open` or `dismissed`; `resolution` says why (`done`: the analyst's Done). Each change emits
`canvas-comments` or `report {status: commented}` on the workspace's stream.

Routes, as thimble 0.8's page calls them:

    GET  /api/ws/{c}/canvas/comments                   the open comments on the cards that are there
    POST /api/ws/{c}/canvas/comments                   {card, text}: the analyst's comment on a card
    POST /api/ws/{c}/canvas/comments/{id}/resolve      Done
    POST /api/ws/{c}/canvas/comments/{id}/reopen       open again
    POST /api/ws/{c}/investigations/main/types/report/comments              {sentence_id, text}
    POST /api/ws/{c}/investigations/main/types/report/comments/{id}/dismiss Done; answers the report
    POST /api/ws/{c}/investigations/main/types/report/comments/{id}/reopen  open again; answers the report
"""
from __future__ import annotations

import difflib
import re
import secrets
import threading
from pathlib import Path
from typing import Any, Callable

from fastapi import Body, HTTPException

from . import canvas, home, report
from .hub import hub

CANVAS_FILE = "canvas-comments.json"
REPORT_FILE = "report.comments.json"
OPEN, SETTLED = "open", "dismissed"
DONE = "done"
ANALYST = "analyst"
TITLE = "title"  # the report title's passage id, as the page names it (report/model.ts TITLE_ID)
TEXT_MAX = 4000  # characters of a comment kept
NEAR = 0.6  # how alike a passage's words must be to the quote for a comment to move there
_lock = threading.RLock()


def _collapse(v: Any) -> str:
    return " ".join(str(v or "").split())


def _new_id(used: set[str]) -> str:
    while True:
        i = "k" + secrets.token_hex(4)
        if i not in used:
            return i


def _read(p: Path) -> list[dict[str, Any]]:
    got = home.read_json(p, {}) or {}
    items = got.get("comments") if isinstance(got, dict) else None
    return [x for x in items or [] if isinstance(x, dict) and x.get("id")]


def _change(p: Path, fn: Callable[[list[dict[str, Any]]], Any]) -> Any:
    """Run `fn(comments)` on the stored list under the lock and write the list it leaves; what fn returns."""
    with _lock:
        items = _read(p)
        out = fn(items)
        home.write_json(p, {"comments": items})
        return out


def _settle(items: list[dict[str, Any]], ids: set[str], by: str) -> list[dict[str, Any]]:
    out = []
    for x in items:
        if str(x["id"]) in ids and (x.get("status") or OPEN) == OPEN:
            x.update(status=SETTLED, resolution=DONE, resolved_by=by, resolved_ts=home.now())
            out.append(dict(x))
    return out


def _unsettle(items: list[dict[str, Any]], ids: set[str]) -> list[dict[str, Any]]:
    out = []
    for x in items:
        if str(x["id"]) in ids and x.get("status") == SETTLED:
            x["status"] = OPEN
            for k in ("resolution", "resolved_by", "resolved_ts", "superseded_by", "superseded_generation"):
                x.pop(k, None)
            out.append(dict(x))
    return out


# --------------------------------------------------------------------------- the cards


def _canvas_path(ws: str) -> Path:
    return home.workspace_dir(ws) / CANVAS_FILE


def add_card_comment(ws: str, *, card: str, text: str, author: str = ANALYST, details: str = "",
                     check: str | None = None, run: str | None = None, evidence: str = "", fp: str = "",
                     step: str | None = None) -> tuple[dict[str, Any], bool]:
    """Store a comment beside card `card` (an id or `card:<id>`), or find the same open one; (the comment, whether it
    is new). KeyError for no such card."""
    _, cell = canvas.find(ws, card)
    cid = cell["id"]
    text = _collapse(text)[:TEXT_MAX]
    details = str(details or "").strip()[:TEXT_MAX]
    if not text:
        raise ValueError("a comment needs its words")

    def fn(items: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        same = next((x for x in items if x.get("card") == cid and x.get("step") == step and x.get("author") == author
                     and x.get("check") == check and x.get("run") == run and (x.get("status") or OPEN) == OPEN
                     and _collapse(x.get("text")) == text and str(x.get("details") or "") == details), None)
        if same is not None:
            return same, False
        cm = {"id": _new_id({str(x["id"]) for x in items}), "card": cid, "step": step, "check": check, "run": run,
              "author": author, "text": text, "details": details, "evidence": evidence, "fp": fp, "ts": home.now(),
              "status": OPEN, "resolution": None}
        items.append(cm)
        return cm, True

    cm, new = _change(_canvas_path(ws), fn)
    if new:
        hub.publish(ws, {"type": "canvas-comments", "card": cid})
    return cm, new


def card_comments(ws: str, *, open_only: bool = True) -> list[dict[str, Any]]:
    """The comments whose card is there, each with its `ref` (`card:<id>`) and `n` (None: no steps here)."""
    cards = {c["id"] for c in canvas.canvas(ws)["cells"]}
    return [{**x, "ref": f"card:{x['card']}", "n": None} for x in _read(_canvas_path(ws))
            if x.get("card") in cards and (not open_only or (x.get("status") or OPEN) == OPEN)]


def resolve_card_comments(ws: str, ids: list[str], by: str = ANALYST) -> list[dict[str, Any]]:
    done = _change(_canvas_path(ws), lambda items: _settle(items, set(ids), by))
    if done:
        hub.publish(ws, {"type": "canvas-comments"})
    return done


def reopen_card_comments(ws: str, ids: list[str]) -> list[dict[str, Any]]:
    done = _change(_canvas_path(ws), lambda items: _unsettle(items, set(ids)))
    if done:
        hub.publish(ws, {"type": "canvas-comments"})
    return done


# --------------------------------------------------------------------------- the report


def _report_path(ws: str) -> Path:
    d = home.workspace_dir(ws) / "docs"
    d.mkdir(parents=True, exist_ok=True)
    return d / REPORT_FILE


def _plain(text: str) -> str:
    """A passage's words for comparing: citations as their words, Markdown marks left out."""
    t = re.sub(r"\[\[([^|\]]*)\|[^\]]*\]\]", r"\1", text or "")
    t = re.sub(r"\[\[[^\]]*\]\]", "", t)
    return _collapse(re.sub(r"[*_`]", "", t))


def passages(doc: dict[str, Any]) -> dict[str, str]:
    """{id: words} of every passage a comment can be on, in reading order: the title, then each section's heading and
    its sentences."""
    out: dict[str, str] = {TITLE: _plain(doc["title"])} if doc.get("title") else {}
    for sec in doc.get("sections") or []:
        if sec.get("heading"):
            out[str(sec["id"])] = _plain(sec["heading"])
        for p in sec.get("paragraphs") or []:
            for s in p.get("sentences") or []:
                out[str(s["id"])] = _plain(s.get("text") or "")
    return out


def anchor(cm: dict[str, Any], here: dict[str, str]) -> str | None:
    """Where comment `cm` stands in the document whose passages are `here`: its own passage while it has the words it
    had, else the passage with those words, else the one most like them, else its own place if that is still there;
    None when its passage is gone."""
    sid, quote = str(cm.get("sentence_id") or ""), _plain(str(cm.get("quote") or ""))
    if not quote or here.get(sid) == quote:
        return sid if sid in here else None
    same = [k for k, v in here.items() if v == quote]
    if same:
        return min(same, key=lambda k: k != sid)
    best, score = None, 0.0
    for k, v in here.items():
        r = difflib.SequenceMatcher(None, quote, v).ratio()
        if r > score:
            best, score = k, r
    if best is not None and score >= NEAR:
        return best
    return sid if sid in here else None


def report_comments(ws: str, doc: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every comment on the report, open or resolved, each at the passage it stands at now (anchor); a comment whose
    passage is gone is left out."""
    doc = doc if doc is not None else report.writeup(ws)
    if doc is None:
        return []
    here = passages(doc)
    out = []
    for cm in _read(_report_path(ws)):
        at = anchor(cm, here)
        if at is not None:
            out.append({**cm, "sentence_id": at})
    return out


def add_report_comment(ws: str, sentence_id: str, text: str, *, author: str = ANALYST, details: str = "",
                       check: str | None = None, run: str | None = None, evidence: str = "",
                       paragraph: bool = False) -> dict[str, Any]:
    """Store a comment on the report's passage `sentence_id`; KeyError when the report has no such passage."""
    doc = report.writeup(ws)
    here = passages(doc) if doc else {}
    if sentence_id not in here:
        raise KeyError(f"the report has no passage {sentence_id}")
    text = _collapse(text)[:TEXT_MAX]
    if not text:
        raise ValueError("a comment needs its words")

    def fn(items: list[dict[str, Any]]) -> dict[str, Any]:
        cm = {"id": _new_id({str(x["id"]) for x in items}), "sentence_id": sentence_id, "text": text,
              "author": author, "ts": home.now(), "status": OPEN, "resolution": None, "quote": here[sentence_id],
              "generation": (doc or {}).get("generation"),
              **({"paragraph": True} if paragraph else {}),
              **({"details": str(details).strip()[:TEXT_MAX]} if details else {}),
              **({"check": check, "run": run} if check else {}), **({"evidence": evidence} if evidence else {})}
        items.append(cm)
        return cm

    cm = _change(_report_path(ws), fn)
    hub.publish(ws, {"type": "report", "slug": report.DOC, "status": "commented", "span": f"report:{report.DOC}#{sentence_id}"})
    return cm


def resolve_report_comments(ws: str, ids: list[str], by: str = ANALYST) -> list[dict[str, Any]]:
    done = _change(_report_path(ws), lambda items: _settle(items, set(ids), by))
    if done:
        hub.publish(ws, {"type": "report", "slug": report.DOC, "status": "commented"})
    return done


def reopen_report_comments(ws: str, ids: list[str]) -> list[dict[str, Any]]:
    done = _change(_report_path(ws), lambda items: _unsettle(items, set(ids)))
    if done:
        hub.publish(ws, {"type": "report", "slug": report.DOC, "status": "commented"})
    return done


def _serve(ws: str, doc: dict[str, Any]) -> None:
    """report.writeup's hook: the document the page reads carries its comments."""
    doc["comments"] = report_comments(ws, doc)


# --------------------------------------------------------------------------- routes


def register(ctx: Any) -> None:
    app = ctx.app
    report.on_serve(_serve)

    # the routes that change a store run on the event loop, where the stream's records are published
    @app.get("/api/ws/{c}/canvas/comments")
    def list_card_comments(c: str) -> dict[str, Any]:
        return {"comments": card_comments(ctx.ws_of(c))}

    @app.post("/api/ws/{c}/canvas/comments", status_code=201)
    async def post_card_comment(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        try:
            cm, _ = add_card_comment(ws, card=str(body.get("card") or ""), text=str(body.get("text") or ""))
        except KeyError:
            raise HTTPException(404, f"no card {body.get('card')!r}") from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return {"comment": {**cm, "ref": f"card:{cm['card']}", "n": None}, "comments": card_comments(ws)}

    @app.post("/api/ws/{c}/canvas/comments/{cid}/resolve")
    async def resolve_card(c: str, cid: str) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        if not resolve_card_comments(ws, [cid]):
            raise HTTPException(404, f"no open comment {cid!r}")
        return {"comments": card_comments(ws)}

    @app.post("/api/ws/{c}/canvas/comments/{cid}/reopen")
    async def reopen_card(c: str, cid: str) -> dict[str, Any]:
        ws = ctx.ws_of(c)
        reopen_card_comments(ws, [cid])
        return {"comments": card_comments(ws)}

    def doc_of(c: str, slug: str) -> str:
        ws = ctx.ws_of(c)
        if slug != report.DOC or report.markdown(ws) is None:
            raise HTTPException(404, f"no document {slug!r}")
        return ws

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/comments", status_code=201)
    async def post_report_comment(c: str, slug: str, body: dict = Body(...)) -> dict[str, Any]:
        ws = doc_of(c, slug)
        try:
            return add_report_comment(ws, str(body.get("sentence_id") or "").strip(), str(body.get("text") or ""))
        except KeyError as e:
            raise HTTPException(404, str(e).strip("'")) from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/comments/{cid}/dismiss")
    async def dismiss(c: str, slug: str, cid: str) -> dict[str, Any]:
        ws = doc_of(c, slug)
        if not resolve_report_comments(ws, [cid]):
            raise HTTPException(404, f"no open comment {cid!r}")
        return report.writeup(ws) or {}

    @app.post("/api/ws/{c}/investigations/main/types/{slug}/comments/{cid}/reopen")
    async def reopen(c: str, slug: str, cid: str) -> dict[str, Any]:
        ws = doc_of(c, slug)
        reopen_report_comments(ws, [cid])
        return report.writeup(ws) or {}
