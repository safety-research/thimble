"""The card check: once an agent's card has its takeaway, one model reading assesses it against five criteria
(prompts/browser/card-check.md) and gives the card that replaces it, and the replacement is applied in place, with Undo
in the card's details (frontend canvas/CheckDetails.tsx, lib/cardCheck.ts).

What the reading sees. thimble browser draws no picture of the card: the reading sees what the card shows as data, a
chart as its Vega-Lite spec with its rows, a table as its rows, a diagram or a timeline as its listing, a matplotlib
figure as the words it draws, and a PNG the code drew as the picture. With it come the question, the takeaway, what each
of the takeaway's links resolves to, the code, and the work that led to the card (the chat of the agent that made it).

When it runs. tools.AFTER hears every tool call: an add_card or edit_card that leaves a card checkable (checkable())
starts its check, when the automatic check is on (`card_check` in the home's checks.json, on by default; PUT
/ws/{c}/card-checks turns it off). The analyst's Check again (POST /ws/{c}/cells/{id}/check) runs it on any checkable
card. A new change to the card cancels a running check and starts the next. At most CONCURRENCY readings run at once.

The record, as in thimble 0.8 (checkstore.py): `cell.check` = {id, basis, status: pending|ok|fixed|error|stopped, phase:
queued|checking|revising, stages: {critique}, started, ended, reason?, author?}; `basis` is a digest of what the check
read, so a check never writes over a card that changed under it. `cell.fixes` lists the changes checks made, oldest
first: {id, check, ts, by: check, fields, before, after, reason, state: applied|undone|rejected}. A fix that changes the
code runs it in the sandbox first and is applied only when it runs clean; the outputs it replaced are kept in
card-checks/<card>/<fix>-before.json for Undo.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import Body, HTTPException

from . import canvas, chats, corpus, home, llm, prompts, tools
from .cards import frames, sandbox
from .hub import hub

log = logging.getLogger("thimble_browser.card_check")

PROMPT = "browser/card-check.md"
CONCURRENCY = 4
EFFORT = "medium"
CONTEXT_CHARS = 30_000
CODE_CHARS = 6000  # of a card's code the reading sees; a longer code is never replaced, since the reading saw part
SPEC_CHARS = 12_000
SPEC_ROWS = 40
CITE_CHARS = 400
REASON_CHARS = 300
FIX_FIELDS = ("title", "code", "takeaway")
HUMAN = ("analyst", "user")  # who made a card, or wrote a takeaway, that a check never changes
CHECK_TOOLS = ("add_card", "edit_card")
VEGALITE = "application/vnd.vegalite.v6.json"
CHANGED = "the card changed while it was checked"
SERVER_STOPPED = "the server stopped while the check ran"
UNRUN = "its revision of the card would not run"

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["assessment", "question", "code", "takeaway"],
    "properties": {
        "assessment": {
            "type": "array", "description": "One item per criterion, in their order.",
            "items": {"type": "object", "additionalProperties": False, "required": ["problem"], "properties": {
                "problem": {"type": "string", "description": "What about the card fails the criterion, in one short "
                            "sentence the analyst could read. Empty when the card meets it, since any text here "
                            "counts as a problem and the analyst sees it."}}}},
        "question": {"type": "string", "description": "The replacement's question."},
        "code": {"type": "string", "description": "The replacement's whole code, empty for a card without code."},
        "takeaway": {"type": "string", "description": "The replacement's takeaway, with its links."},
    },
}

_tasks: dict[tuple[str, str], asyncio.Task] = {}
_sem: asyncio.Semaphore | None = None
_sem_loop: Any = None


def _now() -> str:
    return home.now()


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _short(text: str, n: int = REASON_CHARS) -> str:
    one = " ".join(str(text or "").split())
    return one if len(one) <= n else one[: n - 1].rstrip() + "…"


# ---- the switch

def _conf_path() -> Path:
    return home.root() / "checks.json"


def auto() -> bool:
    """Whether a card an agent's add_card or edit_card leaves checkable is checked by itself."""
    return bool((home.read_json(_conf_path(), {}) or {}).get("card_check", True))


def set_auto(on: bool) -> None:
    home.write_json(_conf_path(), {**(home.read_json(_conf_path(), {}) or {}), "card_check": bool(on)})


# ---- the card

def basis(cell: dict[str, Any]) -> str:
    """A digest of what a check of `cell` reads: its kind, code or payload, question, takeaway and outputs."""
    outs = []
    for o in cell.get("outputs") or []:
        outs.append({k: (str(v)[:4000] if k == "text/plain" else v) for k, v in o.items()
                     if not str(k).startswith("image/") and not k.startswith("_")})
    doc = {"kind": cell.get("kind"), "code": cell.get("code"), "payload": cell.get("payload"),
           "title": cell.get("title"), "takeaway": cell.get("takeaway"), "outputs": outs}
    return hashlib.sha1(json.dumps(doc, sort_keys=True, default=str).encode()).hexdigest()[:16]


def checkable(cell: dict[str, Any]) -> bool:
    """Whether a check can read the card (frontend lib/cardCheck.checkable): it has a takeaway, is not locked or made by
    the analyst, and a card with code ran clean."""
    if cell.get("kind") == "label" or not str(cell.get("takeaway") or "").strip():
        return False
    if cell.get("locked") is True or cell.get("created_by") in HUMAN:
        return False
    if cell.get("kind") in canvas.CODE_KINDS:
        return cell.get("status") == "ok"
    return cell.get("status") not in ("running", "error")


def fixable(cell: dict[str, Any], fields: list[str]) -> list[str]:
    """The ones of `fields` a fix may change: none on a locked card or one the analyst made, no code on a card that runs
    none or whose code the reading saw only part of, and no takeaway the analyst wrote."""
    if cell.get("locked") is True or cell.get("created_by") in HUMAN:
        return []
    out = []
    for f in fields:
        if f == "code" and (cell.get("kind") not in canvas.CODE_KINDS or len(cell.get("code") or "") > CODE_CHARS):
            continue
        if f == "takeaway" and cell.get("takeaway_author") in HUMAN:
            continue
        out.append(f)
    return out


def _edit(ws: str, cid: str, fn: Any, kind: str = "edited") -> dict[str, Any] | None:
    """Change card `cid` with fn(cell) under the canvas's lock; fn returns False to change nothing. The card, or None."""
    with canvas._lock:
        try:
            nb, cell = canvas.find(ws, cid)
        except KeyError:
            return None
        if fn(cell) is False:
            return None
        nb["cells"] = [cell if c["id"] == cell["id"] else c for c in nb["cells"]]
        canvas.save(ws, nb)
    canvas.emit(ws, cell, kind)
    return cell


def _live(cell: dict[str, Any], check_id: str) -> dict[str, Any] | None:
    rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
    if rec is None or rec.get("id") != check_id or rec.get("basis") != basis(cell):
        return None
    return rec


def _phase(ws: str, cid: str, check_id: str, phase: str) -> None:
    def fn(cell: dict[str, Any]) -> bool:
        rec = _live(cell, check_id)
        if rec is None or rec.get("status") != "pending":
            return False
        rec["phase"] = phase
        return True
    _edit(ws, cid, fn, "check")


def _finish(ws: str, cid: str, check_id: str, status: str, reason: str = "", *, stale_ok: bool = False,
            **stages: Any) -> bool:
    def fn(cell: dict[str, Any]) -> bool:
        rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
        if rec is None or rec.get("id") != check_id or rec.get("status") != "pending":
            return False
        if not stale_ok and rec.get("basis") != basis(cell):
            return False
        rec.update(status=status, ended=_now())
        rec.pop("phase", None)
        if reason:
            rec["reason"] = _short(reason)
        for k, v in stages.items():
            rec.setdefault("stages", {})[k] = v
        return True
    return _edit(ws, cid, fn, "check") is not None


# ---- what the reading reads

def _md_links(text: str) -> str:
    """A takeaway in the canvas's form, `[[31|ref]]` and `[[ref]]`, as the Markdown links agents write."""
    def sub(m: re.Match) -> str:
        inner = m.group(1)
        if "|" in inner:
            words, ref = inner.split("|", 1)
            return f"[{words}]({ref})"
        return f"[↗]({inner})"
    return re.sub(r"\[\[((?:[^\[\]\n]|\[[^\[\]\n]*\])+?)\]\]", sub, text or "")


def _refs(text: str) -> list[str]:
    return [m.group(2).strip() for m in canvas.MD_LINK.finditer(_md_links(text))]


def citations(ws: str, folder: Path, cell: dict[str, Any]) -> str:
    lines = []
    for ref in dict.fromkeys(_refs(str(cell.get("takeaway") or ""))):
        try:
            if ref.startswith(("card:", "cell:")):
                ref_ = ref.replace("card:<id>", f"card:{cell['id']}")
                got = canvas.resolve_card_ref(ws, ref_)
                what = got["excerpt"] if got["kind"] == "value" else f"the card {got['excerpt'].splitlines()[0]}"
            else:
                got = corpus.resolve(folder, ref)
                what = str(got.get("excerpt") or got.get("path") or "")
            lines.append(f"- {ref}: {_short(what, CITE_CHARS)}")
        except Exception as e:  # noqa: BLE001
            lines.append(f"- {ref}: does not open ({_short(str(e) or type(e).__name__, 120)})")
    return "\n".join(lines) or "(no links)"


def _svg_words(svg: str) -> str:
    words = [re.sub(r"<[^>]+>", "", t).strip() for t in re.findall(r"<text\b[^>]*>(.*?)</text>", svg, re.S)]
    return " | ".join(w for w in words if w)[:4000]


def _spec(spec: Any) -> str:
    spec = copy.deepcopy(spec)

    def trim(v: Any) -> Any:
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                if k == "values" and isinstance(x, list) and len(x) > SPEC_ROWS:
                    out[k] = x[:SPEC_ROWS] + [f"... {len(x) - SPEC_ROWS} more rows"]
                elif k == "config":
                    continue
                else:
                    out[k] = trim(x)
            return out
        if isinstance(v, list):
            return [trim(x) for x in v]
        return v
    text = json.dumps(trim(spec), ensure_ascii=False)
    return text if len(text) <= SPEC_CHARS else text[:SPEC_CHARS] + " [cut]"


def shown(cell: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """What the card shows, as text, and the pictures among it as image blocks."""
    if cell.get("kind") == "note":
        return f"A note:\n{cell.get('text') or ''}", []
    if cell.get("kind") == "example":
        refs = (cell.get("payload") or {}).get("refs") or []
        return "An example card showing these records:\n" + json.dumps(refs, ensure_ascii=False), []
    if cell.get("kind") == "custom":
        return "A custom card's page:\n" + str((cell.get("payload") or {}).get("html") or "")[:SPEC_CHARS], []
    parts, images = [], []
    for i, o in enumerate(cell.get("outputs") or []):
        if frames.FRAME_MIME in o:
            parts.append(f"[out{i}] a table:\n{o.get('text/plain', '')}")
        elif VEGALITE in o:
            parts.append(f"[out{i}] a chart, as its Vega-Lite spec:\n{_spec(o[VEGALITE])}")
        elif "image/png" in o:
            parts.append(f"[out{i}] a picture, below")
            images.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                       "data": str(o["image/png"])}})
        elif "image/svg+xml" in o:
            parts.append(f"[out{i}] a figure, whose words read: {_svg_words(str(o['image/svg+xml']))}")
        elif "application/vnd.thimble.error+json" in o:
            e = o["application/vnd.thimble.error+json"]
            parts.append(f"[out{i}] an error: {e.get('ename')}: {e.get('evalue')}")
        else:
            parts.append(f"[out{i}] {str(o.get('text/plain', ''))[:SPEC_CHARS]}")
    return "\n\n".join(parts) or "(no output)", images


def author_chat(ws: str, cid: str) -> str | None:
    """The chat whose tool call made or last changed the card."""
    best: tuple[str, str] | None = None
    for m in chats.listing(ws, set()):
        for r in chats.records(ws, m["id"]):
            if r.get("type") == "tool_result" and r.get("cell_id") == cid:
                ts = str(r.get("ts") or "")
                if best is None or ts > best[0]:
                    best = (ts, m["id"])
    return best[1] if best else None


def context(ws: str, chat: str | None) -> str:
    if not chat:
        return "(unknown)"
    out: list[str] = []
    for r in chats.records(ws, chat):
        t = r.get("type")
        if t == "user":
            out.append(f"[analyst] {r.get('text')}")
        elif t == "text":
            if out and out[-1].startswith("[claude] "):
                out[-1] += r.get("delta") or ""
            else:
                out.append("[claude] " + (r.get("delta") or ""))
        elif t == "tool_use":
            out.append(f"[call {r.get('name')}] {_short(json.dumps(r.get('input'), ensure_ascii=False), 1500)}")
        elif t == "tool_result":
            out.append(f"[result] {_short(str(r.get('summary') or ''), 600)}")
    text = "\n".join(out)
    return text if len(text) <= CONTEXT_CHARS else text[-CONTEXT_CHARS:]


def request(ws: str, folder: Path, cell: dict[str, Any], chat: str | None) -> tuple[str, list[dict[str, Any]]]:
    """(the system prompt, the user message's content) of a card's reading."""
    what, images = shown(cell)
    code = str(cell.get("code") or "")
    if len(code) > CODE_CHARS:
        code = code[:CODE_CHARS] + "\n[the code goes on: give it back unchanged]"
    text = "\n".join([
        f"The card is card:{cell['id']}, a {cell.get('kind')} card.", "",
        "Question", str(cell.get("title") or ""), "",
        "Takeaway", _md_links(str(cell.get("takeaway") or "")), "",
        "What each link resolves to", citations(ws, folder, cell), "",
        "Its code", code or "(none)", "",
        "What the card shows", what, "",
        "The work that led to the card, most recent last", context(ws, chat), "",
        "Return your assessment of the card, what fails each of the five criteria, and the card that replaces it, as "
        "JSON: {\"assessment\": [{\"problem\": \"...\"} x5], \"question\": \"...\", \"code\": \"...\", "
        "\"takeaway\": \"...\"}."])
    return prompts.render(PROMPT), [{"type": "text", "text": text}, *images]


def parse(text: str) -> dict[str, Any]:
    got = json.loads(text)
    if not isinstance(got, dict) or not isinstance(got.get("assessment"), list):
        raise ValueError("the reading gave no assessment")
    return {"assessment": [{"problem": str((a or {}).get("problem") or "").strip()} for a in got["assessment"][:5]],
            "question": str(got.get("question") or ""), "code": str(got.get("code") or ""),
            "takeaway": str(got.get("takeaway") or "")}


def _same(a: Any, b: Any) -> bool:
    return " ".join(str(a or "").split()) == " ".join(str(b or "").split())


# ---- running a check

def _semaphore() -> asyncio.Semaphore:
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:
        _sem, _sem_loop = asyncio.Semaphore(CONCURRENCY), loop
    return _sem


def begin(ws: str, cid: str, *, author: str | None = None, again: bool = False) -> str | None:
    """Open a check of card `cid`: its id, or None for a card that is gone, cannot be checked, or was read to the end
    as it stands (unless `again`)."""
    out: list[str] = []

    def fn(cell: dict[str, Any]) -> bool:
        if not checkable(cell):
            return False
        rec = cell.get("check") if isinstance(cell.get("check"), dict) else None
        now = basis(cell)
        if not again and rec is not None and rec.get("basis") == now and rec.get("status") in ("ok", "fixed"):
            return False
        rec = {"id": _id("chk"), "basis": now, "status": "pending", "phase": "queued", "stages": {}, "started": _now(),
               "ended": None, **({"author": author} if author else {})}
        cell["check"] = rec
        out.append(rec["id"])
        return True
    _edit(ws, cid, fn, "check")
    return out[0] if out else None


def start(ws: str, folder: Path, cid: str, *, author: str | None = None, again: bool = False,
          unsandboxed: bool = False) -> str | None:
    """Start a check of card `cid` (one running on it is cancelled first); the check's id, or None."""
    old = _tasks.pop((ws, cid), None)
    if old is not None and not old.done():
        old.cancel()
    check_id = begin(ws, cid, author=author, again=again)
    if check_id is None:
        return None
    task = asyncio.get_running_loop().create_task(_run(ws, folder, cid, check_id, unsandboxed))
    _tasks[(ws, cid)] = task
    task.add_done_callback(lambda t, k=(ws, cid): _tasks.pop(k, None) if _tasks.get(k) is t else None)
    return check_id


async def _run(ws: str, folder: Path, cid: str, check_id: str, unsandboxed: bool) -> None:
    try:
        async with _semaphore():
            _phase(ws, cid, check_id, "checking")
            try:
                cell = canvas.find(ws, cid)[1]
            except KeyError:
                return
            rec = _live(cell, check_id)
            if rec is None:
                return
            system, content = request(ws, folder, cell, rec.get("author") or author_chat(ws, cid))
            t0 = time.monotonic()
            text = await llm.complete(system, content, schema=SCHEMA, effort=EFFORT, max_tokens=16000)  # type: ignore[arg-type]
            if not text:
                _finish(ws, cid, check_id, "error", "Claude declined to read the card")
                return
            got = parse(text)
            critique = {**got, "status": "ok", "s": round(time.monotonic() - t0, 1)}
        await _apply(ws, folder, cid, check_id, got, critique, unsandboxed)
    except asyncio.CancelledError:
        _finish(ws, cid, check_id, "stopped", "", stale_ok=True)
        raise
    except Exception as e:  # noqa: BLE001 — every failure ends the check, which the card's details show
        log.warning("card check of %s failed: %s", cid, type(e).__name__)
        _finish(ws, cid, check_id, "error", llm.failure(e), stale_ok=True)


async def _apply(ws: str, folder: Path, cid: str, check_id: str, got: dict[str, Any], critique: dict[str, Any],
                 unsandboxed: bool) -> None:
    _, cell = canvas.find(ws, cid)
    if _live(cell, check_id) is None:
        _finish(ws, cid, check_id, "stopped", CHANGED, stale_ok=True)
        return
    problems = [a["problem"] for a in got["assessment"] if a["problem"]]
    want = {"title": got["question"], "code": got["code"], "takeaway": got["takeaway"]}
    current = {"title": cell.get("title"), "code": cell.get("code") or "", "takeaway": _md_links(cell.get("takeaway"))}
    changed = [f for f in FIX_FIELDS if want[f].strip() and not _same(want[f], current[f])]
    fields = fixable(cell, changed)
    if not problems or not fields:
        _finish(ws, cid, check_id, "ok", critique=critique)
        return
    reason = problems[0]
    trial = None
    if "code" in fields:
        _phase(ws, cid, check_id, "revising")
        trial = await sandbox.run_code(want["code"], folder, timeout=60, unsandboxed=unsandboxed)
        if trial.get("status") != "ok":
            err = next((o.get("application/vnd.thimble.error+json") for o in trial.get("outputs") or []
                        if "application/vnd.thimble.error+json" in o), None) or {}
            why = f"{err.get('ename', 'error')}: {err.get('evalue', '')}".strip(": ")
            _reject(ws, cid, check_id, {f: want[f] for f in fields}, why or "its code failed")
            _finish(ws, cid, check_id, "error", UNRUN, critique=critique)
            return
    fix_id = _id("fix")
    kept: dict[str, Any] = {}

    def fn(c: dict[str, Any]) -> bool:
        rec = _live(c, check_id)
        if rec is None or rec.get("status") != "pending":
            return False
        before = {f: copy.deepcopy(c.get(f)) for f in fields}
        if "code" in fields and trial is not None:
            kept["run"] = {"outputs": c.get("outputs") or [], "status": c.get("status"),
                           "exec_count": c.get("exec_count")}
            c["code"] = want["code"]
            c["outputs"] = [{**o, "_out": i} for i, o in enumerate(trial.get("outputs") or [])]
            c["status"] = "ok"
            c["exec_count"] = (c.get("exec_count") or 0) + 1
        if "title" in fields:
            c["title"] = want["title"]
        if "takeaway" in fields:
            t = canvas.to_canvas_links(want["takeaway"])
            c["takeaway"] = t.replace("card:card:<id>", f"card:{c['id']}").replace("card:<id>", f"card:{c['id']}")
            c["takeaway_author"] = c.get("takeaway_author") or "check"
        after = {f: copy.deepcopy(c.get(f)) for f in fields}
        c.setdefault("fixes", []).append({"id": fix_id, "check": check_id, "ts": _now(), "by": "check",
                                          "fields": list(fields), "before": before, "after": after,
                                          "reason": reason, "state": "applied"})
        c["ts"] = _now()
        c.setdefault("edited", []).append({"by": "check", "ts": c["ts"]})
        rec.update(status="fixed", ended=_now(), basis=basis(c))
        rec.pop("phase", None)
        rec.setdefault("stages", {})["critique"] = critique
        return True
    if _edit(ws, cid, fn) is None:
        _finish(ws, cid, check_id, "stopped", CHANGED, stale_ok=True)
        return
    if "run" in kept:
        p = _shots(ws, cid) / f"{fix_id}-before.json"
        p.write_text(json.dumps(kept["run"], default=str), encoding="utf-8")


def _shots(ws: str, cid: str) -> Path:
    d = home.workspace_dir(ws) / "card-checks" / cid
    d.mkdir(parents=True, exist_ok=True)
    return d


def _reject(ws: str, cid: str, check_id: str, patch: dict[str, Any], reason: str) -> None:
    """A replacement the check did not keep, recorded as a fix `rejected`; the card is not changed."""
    def fn(c: dict[str, Any]) -> bool:
        c.setdefault("fixes", []).append({"id": _id("fix"), "check": check_id, "ts": _now(), "by": "check",
                                          "fields": list(patch), "before": {f: copy.deepcopy(c.get(f)) for f in patch},
                                          "after": dict(patch), "reason": _short(reason), "state": "rejected"})
        return True
    _edit(ws, cid, fn, "check")


async def stop(ws: str, cid: str) -> bool:
    task = _tasks.pop((ws, cid), None)
    if task is None or task.done():
        def fn(c: dict[str, Any]) -> bool:
            rec = c.get("check") if isinstance(c.get("check"), dict) else None
            if rec is None or rec.get("status") != "pending":
                return False
            rec.update(status="stopped", ended=_now())
            rec.pop("phase", None)
            return True
        return _edit(ws, cid, fn, "check") is not None
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    return True


def undo_fix(ws: str, cid: str, fix_id: str) -> dict[str, Any]:
    """Put back what fix `fix_id` changed, as the analyst's own edit, and mark it `undone`. KeyError for a card or fix
    that does not exist, ValueError for a fix that is not in effect."""
    err: list[Exception] = []

    def fn(c: dict[str, Any]) -> bool:
        fix = next((f for f in c.get("fixes") or [] if isinstance(f, dict) and f.get("id") == fix_id), None)
        if fix is None:
            err.append(KeyError(f"card {cid} has no fix {fix_id}"))
            return False
        if fix.get("state") != "applied":
            err.append(ValueError(f"fix {fix_id} is {fix.get('state')}"))
            return False
        fields = [f for f in fix.get("fields") or [] if f in FIX_FIELDS]
        if not all(_same(json.dumps(c.get(f), default=str), json.dumps((fix.get("after") or {}).get(f), default=str))
                   for f in fields):
            err.append(ValueError(f"card {cid} changed since fix {fix_id}"))
            return False
        before = fix.get("before") or {}
        if "code" in fields:
            c["code"] = before.get("code") or ""
            run = home.read_json(_shots(ws, cid) / f"{fix_id}-before.json", None)
            if isinstance(run, dict):
                c["outputs"], c["status"] = run.get("outputs") or [], run.get("status") or "ok"
            else:
                c["status"] = "idle"
        if "title" in fields:
            c["title"] = before.get("title") or c.get("title") or ""
        if "takeaway" in fields:
            c["takeaway"] = before.get("takeaway") or ""
        fix.update(state="undone", undone=_now())
        c["ts"] = _now()
        c.setdefault("edited", []).append({"by": "analyst", "ts": c["ts"]})
        rec = c.get("check") if isinstance(c.get("check"), dict) else None
        if rec is not None:
            rec["basis"] = basis(c)
        return True
    cell = _edit(ws, cid, fn)
    if err:
        raise err[0]
    if cell is None:
        raise KeyError(cid)
    return cell


def interrupted(ws: str) -> int:
    """End the checks a server that stopped left pending, as errors; how many."""
    n = 0
    for nb in canvas.notebooks(ws):
        changed = False
        for c in nb["cells"]:
            rec = c.get("check") if isinstance(c.get("check"), dict) else None
            if rec is not None and rec.get("status") == "pending":
                rec.update(status="error", ended=_now(), reason=SERVER_STOPPED)
                rec.pop("phase", None)
                changed = True
                n += 1
        if changed:
            with canvas._lock:
                canvas.save(ws, nb)
    return n


def status(ws: str) -> dict[str, Any]:
    running = []
    now = time.time()
    for nb in canvas.notebooks(ws):
        for c in nb["cells"]:
            rec = c.get("check") if isinstance(c.get("check"), dict) else None
            if rec is not None and rec.get("status") == "pending":
                running.append({"card": c["id"], "author": str(rec.get("author") or ""), "check": rec.get("id"),
                                "effort": EFFORT, "phase": rec.get("phase") or "checking", "for_s": 0})
    del now
    return {"enabled": True, "auto": auto(), "render": False,
            "render_why": "thimble browser reads what a card shows as data, not a picture of it",
            "concurrency": CONCURRENCY, "running": running, "timings": []}


# ---- after a tool call

def after_tool(t: tools.Tools, name: str, args: dict[str, Any], result: tools.Result) -> None:
    if name not in CHECK_TOOLS or not result.cell_id or not auto():
        return
    try:
        _, cell = canvas.find(t.ws, result.cell_id)
    except KeyError:
        return
    if not checkable(cell):
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    start(t.ws, t.folder, cell["id"], author=t.chat, unsandboxed=t.unsandboxed)


tools.AFTER.append(after_tool)


def register(ctx: Any) -> None:
    from . import home as _home  # noqa: PLC0415

    for w in _home.list_workspaces():
        try:
            interrupted(w["name"])
        except Exception:  # noqa: BLE001
            log.exception("could not end the checks left pending in %s", w["name"])
    app = ctx.app

    @app.get("/api/ws/{c}/card-checks")
    def card_checks(c: str) -> dict[str, Any]:
        ctx.ws_of(c)
        return status(c)

    @app.put("/api/ws/{c}/card-checks")
    def card_checks_set(c: str, body: dict = Body(...)) -> dict[str, Any]:
        ctx.ws_of(c)
        if "auto" in body:
            set_auto(bool(body["auto"]))
        return status(c)

    @app.post("/api/ws/{c}/card-checks/stop")
    async def card_checks_stop(c: str) -> dict[str, Any]:
        ctx.ws_of(c)
        cards = [k[1] for k in list(_tasks) if k[0] == c]
        for cid in cards:
            await stop(c, cid)
        return {"stopped": cards}

    @app.post("/api/ws/{c}/cells/{cid}/check")
    def card_check_again(c: str, cid: str) -> dict[str, Any]:
        folder = ctx.folder_of(c)
        try:
            _, cell = canvas.find(c, cid)
        except KeyError:
            raise HTTPException(404, f"no card {cid}") from None
        if not checkable(cell):
            raise HTTPException(409, "this card gets no check: it needs a takeaway, and a card the analyst made or "
                                     "locked is not checked")
        check_id = start(c, folder, cell["id"], again=True, unsandboxed=ctx.sessions.unsandboxed)
        if check_id is None:
            raise HTTPException(409, "the check could not start on this card")
        return {"card": cell["id"], "check": check_id}

    @app.post("/api/ws/{c}/cells/{cid}/check/stop")
    async def card_check_stop(c: str, cid: str) -> dict[str, Any]:
        ctx.ws_of(c)
        return {"card": cid, "stopped": await stop(c, cid)}

    @app.post("/api/ws/{c}/cells/{cid}/fixes/{fix}/undo")
    def card_fix_undo(c: str, cid: str, fix: str) -> dict[str, Any]:
        ctx.ws_of(c)
        try:
            return undo_fix(c, cid, fix)
        except KeyError as e:
            raise HTTPException(404, str(e)) from None
        except ValueError as e:
            raise HTTPException(409, str(e)) from None
